import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import pg from "pg";

const required = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "SIGNALDECK_READ_KEY", "SIGNALDECK_WORKSPACE_ID"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
const port = Number(process.env.PORT || 8080);
const workspace = process.env.SIGNALDECK_WORKSPACE_ID;
const key = process.env.SIGNALDECK_READ_KEY;
const pool = new pg.Pool({
  host: process.env.PGHOST, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
  max: 3, connectionTimeoutMillis: 5000, statement_timeout: 8000,
  idleTimeoutMillis: 30000
});
function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
function authorized(header) {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const columns = "id,workspace_id,signal_type,service_name,environment,severity,message,trace_id,span_id,parent_span_id,duration_ms,status_code,attributes,observed_at,created_at";
const types = new Set(["log", "trace", "metric", "k8s_event"]);

// Historical queries are bounded to 2h and 90d to protect latency and data scope.
function queryWindow(url, minutes) {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const now = Date.now();
  if (fromRaw !== null || toRaw !== null) {
    const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
    if (!fromRaw || !toRaw || !isoUtc.test(fromRaw) || !isoUtc.test(toRaw)) return null;
    const from = Date.parse(fromRaw), to = Date.parse(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to ||
        to - from > 2 * 60 * 60_000 || to > now + 60_000 ||
        from < now - 90 * 24 * 60 * 60_000) return null;
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  return { from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now).toISOString() };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { status: "ok" });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
    if (url.pathname === "/ready") { await pool.query("SELECT 1"); return send(res, 200, { status: "ready" }); }
    if (url.pathname === "/v1/telemetry") {
      const rawLimit = url.searchParams.get("limit") ?? "100";
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) return send(res, 400, { error: "invalid_limit" });
      const limit = Math.min(Number(rawLimit), 500);
      const type = url.searchParams.get("type");
      if (type && !types.has(type)) return send(res, 400, { error: "invalid_type" });
      if (type === "trace" && url.searchParams.get("view") === "applications") {
        const allowedMinutes = new Set([15, 60, 360, 1440, 10080]);
        const minutes = Number(url.searchParams.get("minutes") ?? "60");
        if (!allowedMinutes.has(minutes)) return send(res, 400, { error: "invalid_time_range" });
        const window = queryWindow(url, minutes);
        if (!window) return send(res, 400, { error: "invalid_time_window" });
        const service = url.searchParams.get("service") || null;
        if (service && (service.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(service))) return send(res, 400, { error: "invalid_service" });
        const errorsOnly = url.searchParams.get("errors") === "1";
        // Select recent application trace IDs first, then retrieve their complete span groups.
        // This prevents frequent Kubernetes probes from consuming the 500-span window.
        const result = await pool.query(
          `WITH candidate_spans AS MATERIALIZED (
             SELECT trace_id, observed_at
             FROM public.telemetry_events
             WHERE workspace_id = $1 AND signal_type = 'trace'
               AND trace_id IS NOT NULL
               AND observed_at BETWEEN $3::timestamptz AND $6::timestamptz
               AND ($4::text IS NULL OR service_name = $4)
               AND (NOT $5::boolean OR status_code >= 500 OR upper(coalesce(severity,'')) = 'ERROR')
               AND message !~* '(healthz|readyz|livez|/health)([/?[:space:]]|$)'
             ORDER BY observed_at DESC
             LIMIT 1000
           ), selected_traces AS (
             SELECT trace_id, MAX(observed_at) AS latest
             FROM candidate_spans
             GROUP BY trace_id
             ORDER BY latest DESC
             LIMIT 100
           )
           SELECT ${columns.split(",").map((column) => "t." + column).join(",")}
           FROM public.telemetry_events t
           JOIN selected_traces s ON s.trace_id = t.trace_id
           WHERE t.workspace_id = $1 AND t.signal_type = 'trace'
             AND t.observed_at BETWEEN $3::timestamptz AND $6::timestamptz
           ORDER BY s.latest DESC, t.observed_at ASC
           LIMIT $2`,
          [workspace, limit, window.from, service, errorsOnly, window.to]
        );
        return send(res, 200, { records: result.rows, count: result.rowCount });
      }
      if ((type === "k8s_event" || type === "log") && ["investigation", "history"].includes(url.searchParams.get("view"))) {
        const allowedMinutes = new Set([15, 60, 360, 1440, 10080]);
        const minutes = Number(url.searchParams.get("minutes") ?? "60");
        if (!allowedMinutes.has(minutes)) return send(res, 400, { error: "invalid_time_range" });
        const window = queryWindow(url, minutes);
        if (!window) return send(res, 400, { error: "invalid_time_window" });
        // Retain historical anomalies even after the workload returns to normal.
        // Logs are fetched from the incident window, not mixed with Kubernetes snapshots.
        const result = await pool.query(
          `SELECT ${columns} FROM public.telemetry_events
           WHERE workspace_id = $1 AND signal_type = $2
             AND observed_at >= $3::timestamptz AND observed_at <= $5::timestamptz
             AND (
               $6::boolean = false
               OR $2::text = 'log'
               OR (attributes->>'k8s.kind' = 'Deployment'
                   AND attributes->>'k8s.deployment.replicas' = '0')
               OR (attributes->>'k8s.kind' = 'Event'
                   AND upper(coalesce(severity, '')) = 'ERROR')
             )
           ORDER BY observed_at DESC, created_at DESC LIMIT $4`,
          [workspace, type, window.from, limit, window.to, url.searchParams.get("view") === "investigation"]
        );
        return send(res, 200, { records: result.rows, count: result.rowCount });
      }
      const result = await pool.query(
        `SELECT ${columns} FROM public.telemetry_events
         WHERE workspace_id = $1 AND ($2::text IS NULL OR signal_type = $2)
         ORDER BY observed_at DESC, created_at DESC LIMIT $3`,
        [workspace, type || null, limit]
      );
      return send(res, 200, { records: result.rows, count: result.rowCount });
    }
    if (url.pathname === "/v1/coverage") {
      const window = queryWindow(url, 60);
      if (!window) return send(res, 400, { error: "invalid_time_window" });
      const kinds = ["trace", "log", "metric", "k8s_event"];
      // Catalog-only index check. Diagnostics must not issue a table-wide scan.
      const indexes = await pool.query(
        `SELECT idx.relname AS index_name, i.indisvalid AS valid,
                i.indisready AS ready, pg_get_indexdef(idx.oid) AS definition
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
         WHERE ns.nspname = 'public' AND tbl.relname = 'telemetry_events'`
      );
      const hasIndex = indexes.rows.some(i =>
        i.valid && i.ready &&
        String(i.definition).toLowerCase().includes("(workspace_id, signal_type, observed_at")
      );
      if (!hasIndex) return send(res, 200, {
        from: window.from, to: window.to, status: "index_missing",
        index_ready: false,
        signals: kinds.map(signal_type => ({
          signal_type, probe_status: "not_checked", match_found: null,
          oldest_observed_at: null, newest_observed_at: null
        }))
      });
      const client = await pool.connect();
      const signals = [];
      try {
        // One read-only transaction per type; each has an independent
        // 1.2-second statement cap instead of the global 8-second timeout.
        for (const signal_type of kinds) {
          try {
            await client.query("BEGIN READ ONLY");
            await client.query("SET LOCAL statement_timeout = 1200");
            const probe = await client.query(
              `SELECT observed_at FROM public.telemetry_events
               WHERE workspace_id = $1 AND signal_type = $2
                 AND observed_at >= $3::timestamptz
                 AND observed_at <= $4::timestamptz
               ORDER BY observed_at DESC LIMIT 1`,
              [workspace, signal_type, window.from, window.to]
            );
            await client.query("COMMIT");
            const found = probe.rowCount > 0;
            signals.push({
              signal_type, probe_status: found ? "found" : "not_found",
              match_found: found, oldest_observed_at: null,
              newest_observed_at: null
            });
          } catch (error) {
            try { await client.query("ROLLBACK"); } catch {}
            console.error("coverage_probe_error", signal_type, error?.code ?? "unknown");
            signals.push({
              signal_type, probe_status: error?.code === "57014" ? "timed_out" : "unavailable",
              match_found: null, oldest_observed_at: null, newest_observed_at: null
            });
          }
        }
      } finally {
        client.release();
      }
      return send(res, 200, {
        from: window.from, to: window.to, index_ready: true,
        status: signals.every(s => s.match_found !== null) ? "complete" : "partial",
        signals
      });
    }
    if (url.pathname === "/v1/summary") {
      const result = await pool.query(
        `SELECT signal_type, COUNT(*)::integer AS event_count,
                COUNT(DISTINCT service_name)::integer AS service_count,
                MAX(observed_at) AS latest_observed_at
         FROM public.telemetry_events
         WHERE workspace_id = $1 AND created_at >= NOW() - INTERVAL '30 minutes'
         GROUP BY signal_type ORDER BY signal_type`, [workspace]
      );
      return send(res, 200, { window_minutes: 30, signals: result.rows });
    }
    return send(res, 404, { error: "not_found" });
  } catch (error) {
    console.error("read_api_error", error?.message);
    return send(res, 503, { error: "read_unavailable" });
  }
});
server.listen(port, () => console.log(`SignalDeck read API listening on ${port}`));

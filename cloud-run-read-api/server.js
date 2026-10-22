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
        const service = url.searchParams.get("service") || null;
        if (service && (service.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(service))) return send(res, 400, { error: "invalid_service" });
        const errorsOnly = url.searchParams.get("errors") === "1";
        // Select recent application trace IDs first, then retrieve their complete span groups.
        // This prevents frequent Kubernetes probes from consuming the 500-span window.
        const result = await pool.query(
          `WITH selected_traces AS (
             SELECT trace_id, MAX(observed_at) AS latest
             FROM public.telemetry_events
             WHERE workspace_id = $1 AND signal_type = 'trace'
               AND trace_id IS NOT NULL
               AND observed_at >= NOW() - ($3::integer * INTERVAL '1 minute')
               AND ($4::text IS NULL OR trace_id IN (
                 SELECT trace_id FROM public.telemetry_events
                 WHERE workspace_id = $1 AND signal_type = 'trace' AND service_name = $4
                   AND observed_at >= NOW() - ($3::integer * INTERVAL '1 minute')
               ))
               AND (NOT $5::boolean OR trace_id IN (
                 SELECT trace_id FROM public.telemetry_events
                 WHERE workspace_id = $1 AND signal_type = 'trace'
                   AND observed_at >= NOW() - ($3::integer * INTERVAL '1 minute')
                   AND (status_code >= 500 OR upper(coalesce(severity,'')) = 'ERROR')
               ))
               AND message !~* '(healthz|readyz|livez|/health)([/?[:space:]]|$)'
             GROUP BY trace_id ORDER BY latest DESC LIMIT 100
           )
           SELECT ${columns.split(",").map((column) => "t." + column).join(",")}
           FROM public.telemetry_events t
           JOIN selected_traces s ON s.trace_id = t.trace_id
           WHERE t.workspace_id = $1 AND t.signal_type = 'trace'
           ORDER BY s.latest DESC, t.observed_at ASC LIMIT $2`,
          [workspace, limit, minutes, service, errorsOnly]
        );
        return send(res, 200, { records: result.rows, count: result.rowCount });
      }
      if ((type === "k8s_event" || type === "log") && url.searchParams.get("view") === "investigation") {
        const allowedMinutes = new Set([15, 60, 360, 1440, 10080]);
        const minutes = Number(url.searchParams.get("minutes") ?? "60");
        if (!allowedMinutes.has(minutes)) return send(res, 400, { error: "invalid_time_range" });
        // Retrieve historical anomalies separately from the latest-state view.
        // Otherwise frequent healthy Kubernetes snapshots bury short incidents.
        const result = await pool.query(
          `SELECT ${columns} FROM public.telemetry_events
           WHERE workspace_id = $1 AND signal_type = $2
             AND observed_at >= NOW() - ($3::integer * INTERVAL '1 minute')
             AND (
               $2::text = 'log'
               OR (
                 attributes->>'k8s.kind' = 'Deployment'
                 AND (
                   COALESCE(attributes->>'k8s.deployment.replicas', '') = '0'
                   OR (
                     (attributes->>'k8s.deployment.replicas') ~ '^[0-9]+
         ORDER BY observed_at DESC, created_at DESC LIMIT $3`,
        [workspace, type || null, limit]
      );
      return send(res, 200, { records: result.rows, count: result.rowCount });
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

                     AND (attributes->>'k8s.deployment.ready_replicas') ~ '^[0-9]+
         ORDER BY observed_at DESC, created_at DESC LIMIT $3`,
        [workspace, type || null, limit]
      );
      return send(res, 200, { records: result.rows, count: result.rowCount });
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

                     AND (attributes->>'k8s.deployment.ready_replicas')::integer < (attributes->>'k8s.deployment.replicas')::integer
                   )
                 )
               )
               OR (attributes->>'k8s.kind' = 'Event' AND upper(COALESCE(severity,'')) = 'ERROR')
             )
           ORDER BY observed_at DESC, created_at DESC LIMIT $4`,
          [workspace, type, minutes, limit]
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

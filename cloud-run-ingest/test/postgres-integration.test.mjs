import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const dbUrl = process.env.TEST_DATABASE_URL;
const password = "ci-runtime-password";
const key = "ci-only-key";
const headers = { Authorization: `Bearer ${key}` };
const root = new URL("../../", import.meta.url);

async function startService(t, path, port, env) {
  const child = spawn(process.execPath, [path], {
    cwd: root,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (data) => { errors += data.toString(); });
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(child.exitCode, null, `${path} exited: ${errors}`);
    const response = await fetch(`${origin}/healthz`).catch(() => null);
    if (response?.ok) return { origin, errors: () => errors };
    await delay(100);
  }
  assert.fail(`${path} did not start: ${errors}`);
}

function traceFixture(status, service, observedAt) {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const time = BigInt(observedAt.valueOf()) * 1_000_000n + 500_000n;
  return { traceId, spanId, body: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [
        { key: "service.name", value: { stringValue: service } },
        { key: "deployment.environment", value: { stringValue: "lab" } },
      ] },
      scopeSpans: [{ spans: [{
        traceId, spanId, name: "POST /checkout",
        startTimeUnixNano: time.toString(), endTimeUnixNano: (time + 1_000_000n).toString(),
        attributes: [
          { key: "http.response.status_code", value: { intValue: String(status) } },
          { key: "peer.service", value: { stringValue: "inventory" } },
        ],
      }] }],
    }],
  }) };
}

test("OTLP persists durable evidence with the documented ingest and reader grants",
  { skip: !dbUrl, timeout: 60000 }, async (t) => {
    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    t.after(() => admin.end());

    const migrate = (name) => admin.query(readFileSync(new URL(`cloud-sql/migrations/${name}`, root), "utf8"));
    await migrate("001_bootstrap.sql");
    await migrate("003_durable_investigations.sql");
    await migrate("003_durable_investigations.sql");
    // Mirror the deployed table grants with fixture roles in the disposable database.
    await admin.query(`
      CREATE ROLE signaldeck_test_ingest LOGIN PASSWORD '${password}';
      CREATE ROLE signaldeck_test_reader LOGIN PASSWORD '${password}';
      GRANT USAGE ON SCHEMA public TO signaldeck_test_ingest, signaldeck_test_reader;
      GRANT INSERT ON public.telemetry_events, public.investigation_evidence TO signaldeck_test_ingest;
      GRANT SELECT, INSERT, UPDATE ON public.investigations TO signaldeck_test_ingest;
      GRANT SELECT ON public.investigations, public.investigation_evidence TO signaldeck_test_reader;
      INSERT INTO public.workspaces (id, name) VALUES ('default', 'Lab'), ('other', 'Other') ON CONFLICT DO NOTHING;
    `);

    const db = new URL(dbUrl);
    const env = {
      DATABASE_URL: "", PGHOST: db.hostname, PGPORT: db.port || "5432",
      PGDATABASE: db.pathname.slice(1), PGPASSWORD: password,
      SIGNALDECK_WORKSPACE_ID: "default",
    };
    const ingest = await startService(t, "cloud-run-ingest/server.js", 18079, {
      ...env, PGUSER: "signaldeck_test_ingest", SIGNALDECK_INGESTION_KEY: key,
      SIGNALDECK_ARCHIVE_ENABLED: "true",
    });
    const ready = await fetch(`${ingest.origin}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready", archive_enabled: true });

    const postTrace = async ({ body }) => {
      const response = await fetch(`${ingest.origin}/v1/traces`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body,
      });
      assert.equal(response.status, 202, ingest.errors());
      assert.deepEqual(await response.json(), { backend: "postgresql", accepted: 1 });
    };
    const observedAt = new Date();
    const failure = traceFixture(500, "checkout", observedAt);
    await postTrace(failure);
    await postTrace(failure);
    const healthy = traceFixture(200, "healthy-checkout", observedAt);
    await postTrace(healthy);

    const raw = await admin.query(
      "SELECT trace_id, status_code FROM public.telemetry_events WHERE trace_id IN ($1, $2)",
      [failure.traceId, healthy.traceId],
    );
    assert.ok(raw.rows.some((row) => row.trace_id === failure.traceId && row.status_code === 500));
    assert.equal(raw.rows.filter((row) => row.trace_id === healthy.traceId && row.status_code === 200).length, 1);
    // Simulate expiration of the failed trace in this disposable database.
    const removed = await admin.query("DELETE FROM public.telemetry_events WHERE trace_id = $1", [failure.traceId]);
    assert.ok(removed.rowCount > 0);

    const readerEnv = { ...env, PGUSER: "signaldeck_test_reader", SIGNALDECK_READ_KEY: key };
    const reader = await startService(t, "cloud-run-read-api/server.js", 18080, readerEnv);
    const listPath = "/v1/investigations";
    const unauthorized = await fetch(`${reader.origin}${listPath}`);
    assert.equal(unauthorized.status, 401);

    const list = await fetch(`${reader.origin}${listPath}`, { headers });
    assert.equal(list.status, 200);
    const { investigations } = await list.json();
    assert.equal(investigations.length, 1, "replay and healthy spans must not create investigations");
    const [investigation] = investigations;
    assert.equal(investigation.impacted_service, "checkout");
    assert.equal(investigation.verified_mechanism, null);
    assert.ok(investigation.limitations);

    const detailPath = `${listPath}/${investigation.id}`;
    const detail = await fetch(`${reader.origin}${detailPath}`, { headers });
    assert.equal(detail.status, 200);
    const { evidence } = await detail.json();
    assert.equal(evidence.length, 1, "replay must not duplicate source evidence");
    assert.equal(evidence[0].source_type, "trace");
    assert.match(evidence[0].source_event_id, /^[a-f0-9]{64}$/);
    assert.equal(evidence[0].source_event_at, observedAt.toISOString());
    assert.ok(Date.parse(evidence[0].captured_at) >= observedAt.valueOf());
    assert.equal(evidence[0].payload.trace_id, failure.traceId);
    assert.equal(evidence[0].payload.span_id, failure.spanId);
    assert.equal(evidence[0].payload.peer_service, "inventory");

    await assert.rejects(admin.query(`INSERT INTO public.investigation_evidence
      (workspace_id, investigation_id, source_type, source_event_id, summary)
      VALUES ('other', $1, 'trace', 'cross-tenant', 'invalid')`, [investigation.id]), { code: "23503" });
    const otherReader = await startService(t, "cloud-run-read-api/server.js", 18081, {
      ...readerEnv, SIGNALDECK_WORKSPACE_ID: "other",
    });
    const otherList = await fetch(`${otherReader.origin}${listPath}`, { headers });
    assert.equal(otherList.status, 200);
    assert.deepEqual(await otherList.json(), { investigations: [] });
    const otherDetail = await fetch(`${otherReader.origin}${detailPath}`, { headers });
    assert.equal(otherDetail.status, 404);
  });

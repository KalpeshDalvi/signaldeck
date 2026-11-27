import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const dbUrl = process.env.TEST_DATABASE_URL;
const password = "ci-runtime-password";
const key = "ci-only-key";
const headers = { Authorization: `Bearer ${key}` };
const root = new URL("../../", import.meta.url);
const runFile = promisify(execFile);

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
    await migrate("002_telemetry_retention.sql");
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
    // Age only the failed trace, then exercise the raw telemetry cleanup procedure.
    const aged = await admin.query(
      "UPDATE public.telemetry_events SET created_at = now() - interval '8 days' WHERE trace_id = $1",
      [failure.traceId],
    );
    assert.ok(aged.rowCount > 0);
    await admin.query("CALL public.cleanup_old_telemetry(7)");
    const remaining = await admin.query(
      "SELECT trace_id FROM public.telemetry_events WHERE trace_id IN ($1, $2)",
      [failure.traceId, healthy.traceId],
    );
    assert.deepEqual(remaining.rows, [{ trace_id: healthy.traceId }]);

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

function checkoutScenario(service, observedAt) {
  const start = BigInt(observedAt) * 1_000_000n;
  const traceId = randomBytes(16).toString("hex");
  const serverId = randomBytes(8).toString("hex");
  const clientId = randomBytes(8).toString("hex");
  const resource = { attributes: [
    { key: "service.name", value: { stringValue: service } },
    { key: "deployment.environment", value: { stringValue: "lab" } },
  ] };
  const int = (key, value) => ({ key, value: { intValue: String(value) } });
  return {
    traces: { resourceSpans: [{ resource, scopeSpans: [{ spans: [{
      traceId, spanId: serverId, kind: 2, name: "Checkout",
      startTimeUnixNano: String(start), endTimeUnixNano: String(start + 820_000_000n),
      attributes: [int("http.response.status_code", 500)],
    }, {
      traceId, spanId: clientId, parentSpanId: serverId, kind: 3, name: "Inventory request",
      startTimeUnixNano: String(start + 20_000_000n), endTimeUnixNano: String(start + 780_000_000n),
      attributes: [int("http.response.status_code", 503), { key: "peer.service", value: { stringValue: "inventory" } }],
    }] }] }] },
    logs: { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{
      traceId, spanId: serverId, severityNumber: 17, timeUnixNano: String(start + 795_000_000n),
      body: { stringValue: "private-fixture-message" },
      attributes: [
        { key: "signaldeck.event.name", value: { stringValue: "dependency_error_mapped_to_http_response" } },
        int("signaldeck.dependency.status_code", 503),
        int("http.response.status_code", 500),
      ],
    }] }] }] },
  };
}

test("archived checkout findings require claim-specific evidence from OTLP to read API",
  { skip: !dbUrl, timeout: 60000 }, async t => {
    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    t.after(() => admin.end());
    for (const name of ["001_bootstrap.sql", "003_durable_investigations.sql"]) {
      await admin.query(readFileSync(new URL(`cloud-sql/migrations/${name}`, root), "utf8"));
    }
    await admin.query(`
      CREATE ROLE signaldeck_claim_capture LOGIN PASSWORD '${password}';
      CREATE ROLE signaldeck_claim_reader LOGIN PASSWORD '${password}';
      CREATE ROLE signaldeck_claim_investigator LOGIN PASSWORD '${password}';
      GRANT USAGE ON SCHEMA public TO signaldeck_claim_capture, signaldeck_claim_reader, signaldeck_claim_investigator;
      GRANT INSERT ON public.telemetry_events, public.investigation_evidence TO signaldeck_claim_capture;
      GRANT SELECT, INSERT, UPDATE ON public.investigations TO signaldeck_claim_capture;
      GRANT SELECT ON public.investigations, public.investigation_evidence
        TO signaldeck_claim_reader, signaldeck_claim_investigator;
      GRANT UPDATE (hypothesis, immediate_recovery, recurrence_prevention, verification_plan, limitations, updated_at)
        ON public.investigations TO signaldeck_claim_investigator;
      INSERT INTO public.workspaces (id, name) VALUES ('claim-fixture', 'Claim fixture'), ('claim-other', 'Other');
    `);

    const db = new URL(dbUrl);
    const env = {
      DATABASE_URL: "", PGHOST: db.hostname, PGPORT: db.port || "5432",
      PGDATABASE: db.pathname.slice(1), PGPASSWORD: password, SIGNALDECK_WORKSPACE_ID: "claim-fixture",
    };
    const ingest = await startService(t, "cloud-run-ingest/server.js", 18082, {
      ...env, PGUSER: "signaldeck_claim_capture", SIGNALDECK_INGESTION_KEY: key, SIGNALDECK_ARCHIVE_ENABLED: "true",
    });
    const reader = await startService(t, "cloud-run-read-api/server.js", 18083, {
      ...env, PGUSER: "signaldeck_claim_reader", SIGNALDECK_READ_KEY: key,
    });
    const cases = [
      { name: "trace-only", hasLog: false },
      { name: "trace-with-log", hasLog: true },
    ];
    const at = Math.floor((Date.now() - 10000) / 300000) * 300000 + 1000;
    async function publish(signal, payload) {
      const response = await fetch(`${ingest.origin}/v1/${signal}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 202, ingest.errors());
    }
    for (const entry of cases) {
      const fixture = checkoutScenario(entry.name, at);
      await publish("traces", fixture.traces);
      if (entry.hasLog) await publish("logs", fixture.logs);
    }
    const { rows: [outside] } = await admin.query(`
      INSERT INTO public.investigations (workspace_id, incident_key, incident_at, environment, hypothesis)
      VALUES ('claim-other','app:lab:other-fixture', now(), 'lab',
        'Failure signal observed; underlying cause is not yet verified') RETURNING id
    `);
    const listPath = `${reader.origin}/v1/investigations`;
    const readArchive = async url => {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    const before = await readArchive(listPath);
    assert.equal(before.investigations.length, 2);

    const runJob = async (unsupported, ...args) => runFile(process.execPath, [
      "--import", new URL("cloud-run-investigator/test/fixtures/mock-vertex.mjs", root).href,
      "cloud-run-investigator/job.js", ...args,
    ], { cwd: root, env: {
      ...process.env, ...env, PGUSER: "signaldeck_claim_investigator", SIGNALDECK_AI_ENABLED: "true",
      SIGNALDECK_TEST_UNSUPPORTED_CLAIM: String(unsupported), SIGNALDECK_GKE_CLUSTER: "fixture-cluster",
      SIGNALDECK_GCP_PROJECT_ID: "fixture-project", SIGNALDECK_GCP_LOG_VIEW: "",
      SIGNALDECK_VERTEX_REGION: "us", SIGNALDECK_VERTEX_MODEL: "fixture-model",
    }, timeout: 10000 });

    await assert.rejects(runJob(true), error => {
      assert.match(error.stderr, /unsupported_ai_claim/);
      return true;
    });
    await assert.rejects(runJob(false, "--analyze-incident", outside.id), { stderr: /app_incident_not_eligible/ });
    assert.deepEqual(await readArchive(listPath), before);
    const target = before.investigations.find(record => record.impacted_service === "trace-with-log");
    assert.deepEqual(JSON.parse((await runJob(false, "--analyze-incident", target.id)).stdout), {
      event: "signaldeck_targeted_analysis_completed", ai_findings: 1,
    });
    const remaining = (await readArchive(listPath)).investigations.find(record => record.impacted_service === "trace-only");
    assert.equal(remaining.hypothesis, "Failure signal observed; underlying cause is not yet verified");
    assert.equal(JSON.parse((await runJob(false)).stdout).ai_findings, 1);
    assert.equal(JSON.parse((await runJob(false)).stdout).ai_findings, 0);
    const { rows: [other] } = await admin.query("SELECT hypothesis FROM public.investigations WHERE workspace_id='claim-other'");
    assert.equal(other.hypothesis, "Failure signal observed; underlying cause is not yet verified");

    for (const entry of cases) {
      const id = before.investigations.find(record => record.impacted_service === entry.name).id;
      const { investigation, evidence } = await readArchive(`${listPath}/${id}`);
      assert.equal(investigation.verified_mechanism, null);
      assert.equal(investigation.initiating_change, null);
      assert.match(investigation.limitations, /Root cause remains unverified/);
      assert.match(investigation.limitations, /cause of the dependency response remains unknown/);
      assert.doesNotMatch(investigation.hypothesis, /Invented free-form diagnosis|Invented verification/);
      const server = evidence.find(item => item.payload.status_code === 500);
      const dependency = evidence.find(item => item.payload.status_code === 503);
      assert.ok(investigation.hypothesis.includes(`HTTP 500. [Source IDs: ${server.source_event_id}]`));
      assert.ok(investigation.hypothesis.includes(`HTTP 503. [Source IDs: ${dependency.source_event_id}]`));
      if (entry.hasLog) {
        const log = evidence.find(item => item.source_type === "application_log");
        assert.deepEqual(log.payload.response_handling, { dependency_status_code: 503, response_status_code: 500 });
        assert.ok(investigation.hypothesis.includes(`mapped the dependency's HTTP 503 to HTTP 500. [Source IDs: ${log.source_event_id}, ${server.source_event_id}, ${dependency.source_event_id}]`));
      } else {
        assert.match(investigation.limitations, /Application response handling remains unknown/);
        assert.doesNotMatch(investigation.hypothesis, /mapped/);
      }
    }
  });

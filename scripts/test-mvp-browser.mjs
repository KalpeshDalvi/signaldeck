import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const standalone = new URL(".next/standalone/", root);
const dbUrl = process.env.TEST_BROWSER_DATABASE_URL;
const writerPassword = "fixture-writer";
const ingestPassword = "fixture-ingest";
const readerPassword = "fixture-reader";
const ingestKey = "fixture-ingest-key";
const readKey = "fixture-read-key";

function jsonToken() {
  const encode = input => Buffer.from(JSON.stringify(input)).toString("base64url");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return encode({ alg: "HS256" }) + "." + encode({ exp: expires }) + ".fixture";
}

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function start(t, { file, cwd = root, port, endpoint, env }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(file, cwd))], {
    cwd, env: { PATH: process.env.PATH, TZ: "UTC", HOSTNAME: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exit = once(child, "exit");
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-2000); });
  const stop = async () => {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    await exit;
  };
  t.after(stop);
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert.equal(child.exitCode, null, diagnostics);
    const live = await fetch(origin + endpoint, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (live?.ok) return { origin, stop };
    await wait(100);
  }
  assert.fail(`${file} did not become ready: ${diagnostics}`);
}

function traceFixture(status, hasFailedDependency = false) {
  const traceId = randomBytes(16).toString("hex");
  const serverSpan = randomBytes(8).toString("hex");
  const start = BigInt(Date.now()) * 1_000_000n;
  const attribute = (key, value) => ({
    key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
  });
  const span = (id, kind, method, route, code, begin, end) => ({
    traceId, spanId: id, kind, name: `${method} ${route}`,
    startTimeUnixNano: begin.toString(), endTimeUnixNano: end.toString(),
    attributes: [
      attribute("http.request.method", method), attribute("http.route", route),
      attribute("http.response.status_code", code),
    ],
  });
  const spans = [span(serverSpan, 2, "POST", "/checkout", status, start, start + 25_000_000n)];
  if (hasFailedDependency) {
    const dependency = span(randomBytes(8).toString("hex"), 3, "GET", "/inventory", 503,
      start + 1_000_000n, start + 20_000_000n);
    dependency.parentSpanId = serverSpan;
    dependency.attributes.push(attribute("server.address", "inventory"));
    spans.push(dependency);
  }
  return {
    traceId, count: spans.length,
    body: { resourceSpans: [{
      resource: { attributes: [attribute("service.name", "checkout"), attribute("deployment.environment", "lab")] },
      scopeSpans: [{ spans }],
    }] },
  };
}

test("disposable browser completes a linked incident and retains its resolution after replay",
  { skip: !dbUrl, timeout: 90_000 }, async t => {
    const database = new URL(dbUrl);
    assert.equal(database.protocol, "postgresql:");
    assert.equal(database.hostname, "127.0.0.1");
    assert.equal(database.pathname, "/signaldeck_browser_test");
    assert.equal(database.search, "");
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    t.after(() => db.end());
    const existing = await db.query("SELECT to_regclass('public.workspaces') AS workspaces");
    assert.equal(existing.rows[0].workspaces, null, "the browser test requires an empty disposable database");
    for (const file of [
      "001_bootstrap.sql", "002_telemetry_retention.sql", "003_durable_investigations.sql",
      "005_incident_lifecycle_runtime_grants.sql", "006_investigation_acknowledgements.sql",
      "007_incident_investigation_links.sql",
    ]) {
      await db.query(await readFile(new URL("cloud-sql/migrations/" + file, root), "utf8"));
    }
    await db.query(`
      ALTER ROLE signaldeck_incident_writer PASSWORD '${writerPassword}';
      CREATE ROLE mvp_browser_ingest LOGIN PASSWORD '${ingestPassword}';
      CREATE ROLE mvp_browser_reader LOGIN PASSWORD '${readerPassword}';
      GRANT USAGE ON SCHEMA public TO mvp_browser_ingest, mvp_browser_reader;
      GRANT INSERT ON public.telemetry_events, public.investigation_evidence TO mvp_browser_ingest;
      GRANT SELECT, INSERT, UPDATE ON public.investigations TO mvp_browser_ingest;
      GRANT SELECT ON public.telemetry_events, public.investigations, public.investigation_evidence TO mvp_browser_reader;
      INSERT INTO public.workspaces (id,name) VALUES ('default','Browser fixture'), ('other','Hidden fixture');
    `);
    const { rows: [foreignArchive] } = await db.query(`
      INSERT INTO public.investigations (workspace_id,incident_key,incident_at,environment,impacted_service)
      VALUES ('other','app:lab:checkout:hidden',now(),'lab','checkout') RETURNING id
    `);

    const databaseEnv = { PGHOST: database.hostname, PGPORT: database.port || "5432",
      PGDATABASE: database.pathname.slice(1), SIGNALDECK_WORKSPACE_ID: "default" };
    const ingest = await start(t, {
      file: "cloud-run-ingest/server.js", port: 18799, endpoint: "/healthz",
      env: { ...databaseEnv, PGUSER: "mvp_browser_ingest", PGPASSWORD: ingestPassword,
        SIGNALDECK_INGESTION_KEY: ingestKey, SIGNALDECK_ARCHIVE_ENABLED: "true" },
    });
    const reader = await start(t, {
      file: "cloud-run-read-api/server.js", port: 18800, endpoint: "/healthz",
      env: { ...databaseEnv, PGUSER: "mvp_browser_reader", PGPASSWORD: readerPassword, SIGNALDECK_READ_KEY: readKey },
    });
    async function postTrace(fixture) {
      const response = await fetch(ingest.origin + "/v1/traces", {
        method: "POST", headers: { Authorization: "Bearer " + ingestKey, "Content-Type": "application/json" },
        body: JSON.stringify(fixture.body), signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).accepted, fixture.count);
    }

    // Loopback metadata and gateway exercise the dashboard's two auth headers without cloud credentials.
    const token = jsonToken();
    const metadata = await serve(t, (request, response) => {
      response.setHeader("Metadata-Flavor", "Google");
      response.end(request.url.includes("/identity") ? token : "local-fixture");
    });
    const gateway = await serve(t, async (request, response) => {
      if (request.headers.authorization !== "Bearer " + readKey ||
          request.headers["x-serverless-authorization"] !== "Bearer " + token) {
        response.writeHead(401).end();
        return;
      }
      try {
        const target = new URL(reader.origin);
        const requested = new URL(request.url, reader.origin);
        target.pathname = requested.pathname;
        target.search = requested.search;
        const upstream = await fetch(target, { headers: { Authorization: request.headers.authorization },
          signal: AbortSignal.timeout(5000) });
        response.writeHead(upstream.status, { "Content-Type": "application/json" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502).end();
      }
    });
    await cp(new URL(".next/static/", root), new URL(".next/static/", standalone), { recursive: true });
    const dashboard = () => start(t, {
      file: "server.js", cwd: standalone, port: 18801, endpoint: "/api/health",
      env: { NO_PROXY: "127.0.0.1", GCE_METADATA_HOST: new URL(metadata).host,
        SIGNALDECK_READ_API_URL: gateway, SIGNALDECK_READ_API_KEY: readKey,
        SIGNALDECK_WORKSPACE_ID: "default", SIGNALDECK_INCIDENT_DB_HOST: database.hostname,
        SIGNALDECK_INCIDENT_DB_PORT: databaseEnv.PGPORT, SIGNALDECK_INCIDENT_DB_NAME: databaseEnv.PGDATABASE,
        SIGNALDECK_INCIDENT_DB_PASSWORD: writerPassword },
    });
    const app = await dashboard();
    const failure = traceFixture(500, true);
    await postTrace(failure);
    const { rows: [archive] } = await db.query(`
      SELECT id FROM public.investigations WHERE workspace_id='default' AND impacted_service='checkout'
    `);
    assert.ok(archive);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(app.origin + "/incidents");
      const active = page.locator("a[href^='/incidents/']").filter({ hasText: /checkout ·/ });
      const detailPath = await active.getAttribute("href");
      assert.match(detailPath, /^\/incidents\/[a-f0-9-]{36}$/);
      await active.click();
      await page.waitForLoadState("networkidle");
      const lifecycle = page.locator(".lifecycle-card");
      await lifecycle.getByPlaceholder("Assign incident commander").fill("Fixture responder");
      const assign = page.waitForResponse(response => response.request().method() === "PATCH");
      await lifecycle.getByRole("button", { name: "Assign" }).click();
      const assignment = await assign;
      assert.equal(assignment.status(), 200);
      assert.equal((await assignment.json()).incident.owner, "Fixture responder");
      await lifecycle.getByRole("button", { name: "mitigated" }).click();
      await lifecycle.locator(".lifecycle-mitigated").waitFor();
      const note = "Mitigated the controlled checkout failure";
      await lifecycle.getByPlaceholder("Add an investigation update, decision, or mitigation note...").fill(note);
      await lifecycle.getByRole("button", { name: "Add timeline note" }).click();
      await page.getByRole("region", { name: "Responder notes" }).getByText(note).waitFor();

      const linked = page.getByRole("region", { name: "Linked investigations" });
      async function attach(id) {
        await linked.getByLabel("Saved investigation ID").fill(id);
        await linked.getByRole("button", { name: "Link investigation" }).click();
      }
      await attach(foreignArchive.id);
      await linked.getByText("Enter a saved investigation ID for this service and environment.").waitFor();
      await attach(archive.id);
      await linked.getByText("Investigation linked.", { exact: true }).waitFor();
      await linked.getByRole("link", { name: "Saved investigation " + archive.id }).click();
      await page.getByText(/Check serving health and recent changes for inventory/).waitFor();
      await page.getByRole("link", { name: "Open incident response" }).click();

      const successful = traceFixture(200);
      await postTrace(successful);
      await linked.getByLabel("Successful trace ID from the last hour").fill(successful.traceId);
      await linked.getByRole("button", { name: "Verify recovery" }).click();
      await linked.getByText("Recovery check saved to responder notes.").waitFor();
      const notes = page.getByRole("region", { name: "Responder notes" });
      await notes.getByText(new RegExp(successful.traceId)).waitFor();
      await linked.getByLabel("Successful trace ID from the last hour").fill(successful.traceId);
      await linked.getByRole("button", { name: "Verify recovery" }).click();
      await linked.getByText("The check was already saved or the incident status changed.").waitFor();
      await lifecycle.getByRole("button", { name: "resolved" }).click();
      await lifecycle.locator(".lifecycle-resolved").waitFor();

      await app.stop();
      const restarted = await dashboard();
      await postTrace(failure);
      await page.goto(restarted.origin + "/incidents");
      await page.getByRole("heading", { name: "No active incident", exact: true }).waitFor();
      const { rows } = await db.query(`
        SELECT id,status,owner,resolved_at,notes FROM public.incidents
        WHERE workspace_id='default' AND service_name='checkout'
      `);
      assert.equal(rows.length, 1);
      const [closed] = rows;
      assert.equal(detailPath, "/incidents/" + closed.id);
      assert.equal(closed.status, "resolved");
      assert.equal(closed.owner, "Fixture responder");
      assert.ok(closed.resolved_at);
      assert.ok(closed.notes.some(entry => entry.message === note));
      const checks = closed.notes.flatMap(entry => entry.recovery_validation ? [entry.recovery_validation] : []);
      assert.equal(checks.length, 1);
      const { rows: evidence } = await db.query(`
        SELECT source_event_id,payload FROM public.investigation_evidence
        WHERE workspace_id='default' AND investigation_id=$1
      `, [archive.id]);
      assert.equal(evidence.length, 2);
      const failedServer = evidence.find(item => item.payload.span_kind === "2");
      const { rows: [probe] } = await db.query("SELECT id FROM public.telemetry_events WHERE trace_id=$1", [successful.traceId]);
      assert.equal(checks[0].failed_source_id, failedServer.source_event_id);
      assert.equal(checks[0].telemetry_source_id, probe.id);

      await db.query("UPDATE public.telemetry_events SET created_at=now()-interval '8 days' WHERE workspace_id='default'");
      await db.query("CALL public.cleanup_old_telemetry(7)");
      await page.goto(restarted.origin + detailPath);
      await lifecycle.locator(".lifecycle-resolved").waitFor();
      await notes.getByText(new RegExp(successful.traceId)).waitFor();
      await linked.getByRole("link", { name: "Saved investigation " + archive.id }).click();
      await page.getByText(new RegExp(failedServer.source_event_id)).first().waitFor();
    } finally {
      await browser.close();
    }
  });

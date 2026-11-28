import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import type { IncidentCandidate } from "../incidents";

const connectionString = process.env.TEST_DATABASE_URL;

test("dashboard persists incident lifecycle with restricted PostgreSQL grants",
  { skip: !connectionString, timeout: 20000 }, async t => {
    const url = new URL(connectionString!);
    const admin = new Client({ connectionString });
    await admin.connect();
    t.after(() => admin.end());
    for (const name of ["001_bootstrap.sql", "003_durable_investigations.sql", "005_incident_lifecycle_runtime_grants.sql", "005_incident_lifecycle_runtime_grants.sql",
      "007_incident_investigation_links.sql", "007_incident_investigation_links.sql"]) {
      await admin.query(await readFile(new URL(`../../cloud-sql/migrations/${name}`, import.meta.url), "utf8"));
    }
    await admin.query(`
      ALTER ROLE signaldeck_incident_writer PASSWORD 'incident-test-password';
      INSERT INTO public.workspaces (id, name) VALUES ('lifecycle', 'Lifecycle'), ('other-lifecycle', 'Other');
    `);
    Object.assign(process.env, {
      SIGNALDECK_WORKSPACE_ID: "lifecycle",
      SIGNALDECK_INCIDENT_DB_HOST: url.hostname,
      SIGNALDECK_INCIDENT_DB_PORT: url.port || "5432",
      SIGNALDECK_INCIDENT_DB_NAME: url.pathname.slice(1),
      SIGNALDECK_INCIDENT_DB_PASSWORD: "incident-test-password",
    });
    const { incidentPool } = await import("../incident-postgres");
    const { addIncidentNote, ensureIncidents, getIncident, IncidentNotFoundError, listIncidentHistory, listIncidents, recordIncidentRecovery, updateIncident } = await import("../incidents");
    const writer = incidentPool()!;
    t.after(() => writer.end());

    const checkout: IncidentCandidate = {
      workspace_id: "lifecycle", service_name: "checkout", environment: "lab",
      title: "Checkout failure", summary: "Fixture failed trace", severity: "SEV-1",
    };
    const inventory = { ...checkout, service_name: "inventory", title: "Inventory failure" };
    const [first, second] = await Promise.all([
      ensureIncidents([checkout, inventory]), ensureIncidents([inventory, checkout, checkout]),
    ]);
    const [incident, dependency] = first;
    assert.deepEqual(second.map(item => item.id), [dependency.id, incident.id, incident.id]);
    assert.equal((await listIncidents()).length, 2);
    assert.equal((await ensureIncidents([checkout]))[0].updated_at, incident.updated_at);

    await Promise.all([
      updateIncident(incident.id, { owner: "On-call" }),
      updateIncident(incident.id, { status: "mitigated" }),
      addIncidentNote(incident.id, "On-call", "Evidence saved"),
      addIncidentNote(incident.id, "On-call", "Mitigation confirmed"),
    ]);
    const changed = { ...checkout, summary: "Refreshed failure evidence" };
    const [stored] = await ensureIncidents([changed, inventory]);
    assert.equal(stored.id, incident.id);
    assert.equal(stored.owner, "On-call");
    assert.equal(stored.summary, changed.summary);
    assert.equal(stored.status, "mitigated");
    assert.ok(stored.mitigated_at);
    assert.deepEqual(stored.notes.map(note => note.message).sort(), ["Evidence saved", "Mitigation confirmed"]);

    const { rows: [other] } = await admin.query(`
      INSERT INTO public.incidents (workspace_id, service_name, environment, title, severity, status)
      VALUES ('other-lifecycle', 'checkout', 'lab', 'Other incident', 'SEV-1', 'detected') RETURNING id
    `);
    assert.equal(await getIncident(other.id), null);
    await assert.rejects(updateIncident(other.id, { owner: "Wrong workspace" }), IncidentNotFoundError);
    await assert.rejects(addIncidentNote(other.id, "On-call", "Wrong workspace"), IncidentNotFoundError);
    await assert.rejects(listIncidents("other-lifecycle"), /workspace is unavailable/);
    await assert.rejects(ensureIncidents([{ ...checkout, workspace_id: "other-lifecycle" }]), /workspace is unavailable/);
    assert.equal(await getIncident("invalid-id"), null);

    await assert.rejects(writer.query("DELETE FROM public.incidents WHERE false"), { code: "42501" });
    await assert.rejects(writer.query("UPDATE public.incidents SET workspace_id = 'other-lifecycle' WHERE false"), { code: "42501" });
    await assert.rejects(writer.query("SELECT workspace_id FROM public.telemetry_events LIMIT 0"), { code: "42501" });

    const { rows: saved } = await admin.query(`
      INSERT INTO public.investigations (workspace_id, incident_key, incident_at, environment)
      VALUES ('lifecycle', 'app:lab:checkout:link', now(), 'lab'),
             ('other-lifecycle', 'app:lab:checkout:link', now(), 'lab'),
             ('lifecycle', 'app:lab:checkout:unlinked', now(), 'lab')
      RETURNING id, workspace_id, incident_key
    `);
    const ownArchive = saved.find(row => row.workspace_id === "lifecycle")!.id;
    const privateArchive = saved.find(row => row.workspace_id === "other-lifecycle")!.id;
    const { linkIncidentInvestigation, getInvestigationIncidentId, listIncidentInvestigationIds } =
      await import("../incident-investigation-links");
    assert.equal(await linkIncidentInvestigation(incident.id, ownArchive), "linked");
    assert.equal(await linkIncidentInvestigation(incident.id, ownArchive), "linked");
    assert.equal(await linkIncidentInvestigation(dependency.id, ownArchive), "conflict");
    assert.equal(await getInvestigationIncidentId(ownArchive), incident.id);
    assert.deepEqual(await listIncidentInvestigationIds(incident.id), [ownArchive]);
    assert.equal(await getInvestigationIncidentId(privateArchive), null);
    await assert.rejects(linkIncidentInvestigation(incident.id, privateArchive), { code: "23503" });
    const unlinkedArchive = saved.find(row => row.incident_key.endsWith(":unlinked"))!.id;
    await assert.rejects(linkIncidentInvestigation(other.id, unlinkedArchive), { code: "23503" });
    await assert.rejects(writer.query("DELETE FROM public.incident_investigation_links"), { code: "42501" });
    const validation = {
      investigation_id: ownArchive, failed_source_id: "failure-source", telemetry_source_id: "probe-source",
      trace_id: "probe-trace", span_id: "probe-span", http_status: 200,
      observed_at: new Date(Date.parse(stored.mitigated_at!) + 1000).toISOString(),
      mitigated_at: stored.mitigated_at!,
    };
    assert.deepEqual((await Promise.all([
      recordIncidentRecovery(incident.id, validation), recordIncidentRecovery(incident.id, validation),
    ])).sort(), [false, true]);
    assert.equal(await recordIncidentRecovery(other.id, { ...validation, telemetry_source_id: "foreign-probe" }), false);
    assert.deepEqual((await getIncident(incident.id))?.notes.find(note => note.recovery_validation)?.recovery_validation, validation);

    const resolved = await updateIncident(incident.id, { owner: null, status: "resolved" });
    assert.equal(resolved.owner, null);
    assert.equal(resolved.mitigated_at, stored.mitigated_at);
    assert.ok(resolved.resolved_at);
    const staleCandidate = { ...checkout, latest_signal_at: resolved.resolved_at! };
    const [replayed] = await ensureIncidents([{ ...staleCandidate, summary: "Stale replay" }]);
    assert.deepEqual(replayed, resolved);
    assert.equal((await listIncidents()).length, 2);
    assert.equal((await updateIncident(resolved.id, { status: "resolved" })).resolved_at, resolved.resolved_at);

    const reopened = await updateIncident(resolved.id, { status: "investigating" });
    assert.equal(reopened.resolved_at, null);
    assert.deepEqual(reopened.notes, resolved.notes);
    const reclosed = await updateIncident(resolved.id, { status: "resolved" });
    assert.ok(reclosed.resolved_at);
    assert.equal((await ensureIncidents([staleCandidate]))[0].id, resolved.id);
    const [newIncident] = await ensureIncidents([{
      ...checkout, latest_signal_at: new Date(Date.parse(reclosed.resolved_at!) + 1).toISOString(),
    }]);
    assert.notEqual(newIncident.id, resolved.id);
    assert.deepEqual(await getIncident(resolved.id), reclosed);

    const history = await listIncidentHistory();
    const historicalRecord = history.find(entry => entry.id === resolved.id);
    assert.equal(historicalRecord?.status, "resolved");
    assert.equal(historicalRecord?.owner, null);
    assert.ok(historicalRecord && !("notes" in historicalRecord));
    assert.ok(!history.some(entry => entry.id === other.id));

    const payments = { ...checkout, service_name: "payments" };
    const invalid = { ...checkout, service_name: "invalid", severity: "invalid" as IncidentCandidate["severity"] };
    await assert.rejects(ensureIncidents([payments, invalid]), { code: "23514" });
    assert.equal((await listIncidents()).some(item => item.service_name === "payments"), false);
    assert.equal((await ensureIncidents([payments]))[0].service_name, "payments");

    await admin.query(`
      INSERT INTO public.incidents
        (workspace_id, service_name, title, environment, severity, status, updated_at)
      SELECT 'lifecycle', 'history-fixture-' || ordinal, 'Fixture', 'lab', 'SEV-3', 'resolved',
        now() - ordinal * interval '1 day'
      FROM generate_series(1, 35) AS ordinal
    `);
    const recent = await listIncidentHistory();
    assert.equal(recent.length, 30);
    assert.ok(recent.every((entry, index) => index === 0 || entry.updated_at <= recent[index - 1].updated_at));
  });

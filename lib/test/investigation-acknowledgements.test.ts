import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";

const connectionString = process.env.TEST_DATABASE_URL;

test("alert acknowledgement is atomic, durable and workspace scoped",
  { skip: !connectionString, timeout: 20_000 }, async t => {
    const database = new URL(connectionString!);
    const admin = new Client({ connectionString });
    await admin.connect();
    t.after(() => admin.end());
    for (const name of ["001_bootstrap.sql", "003_durable_investigations.sql", "005_incident_lifecycle_runtime_grants.sql",
      "006_investigation_acknowledgements.sql", "006_investigation_acknowledgements.sql"]) {
      await admin.query(await readFile(new URL(`../../cloud-sql/migrations/${name}`, import.meta.url), "utf8"));
    }
    await admin.query(`
      ALTER ROLE signaldeck_incident_writer PASSWORD 'acknowledgement-test-password';
      INSERT INTO public.workspaces (id, name) VALUES ('alert-test', 'Alert test'), ('alert-private', 'Private test');
    `);
    const { rows: investigations } = await admin.query<{ id: string; workspace_id: string }>(`
      INSERT INTO public.investigations (workspace_id, incident_key, incident_at, environment)
      VALUES ('alert-test', 'app:lab:checkout:1', now(), 'lab'),
             ('alert-private', 'app:lab:checkout:1', now(), 'lab')
      RETURNING id, workspace_id
    `);
    const id = investigations.find(row => row.workspace_id === "alert-test")!.id;
    const otherId = investigations.find(row => row.workspace_id === "alert-private")!.id;
    await admin.query(`
      INSERT INTO public.investigation_acknowledgements (workspace_id, investigation_id)
      VALUES ('alert-private', $1)
    `, [otherId]);

    Object.assign(process.env, {
      SIGNALDECK_WORKSPACE_ID: "alert-test",
      SIGNALDECK_INCIDENT_DB_HOST: database.hostname,
      SIGNALDECK_INCIDENT_DB_PORT: database.port || "5432",
      SIGNALDECK_INCIDENT_DB_NAME: database.pathname.slice(1),
      SIGNALDECK_INCIDENT_DB_PASSWORD: "acknowledgement-test-password",
    });
    const { incidentPool } = await import("../incident-postgres");
    const { acknowledgeInvestigation, listInvestigationAcknowledgements } = await import("../investigation-acknowledgements");
    const db = incidentPool()!;
    t.after(() => db.end());

    assert.equal((await listInvestigationAcknowledgements(db, [id, otherId])).size, 0);
    assert.deepEqual(await Promise.all([
      acknowledgeInvestigation(db, id),
      acknowledgeInvestigation(db, id),
    ]), ["acknowledged", "acknowledged"]);
    const acknowledged = await listInvestigationAcknowledgements(db, [id, otherId]);
    assert.equal(acknowledged.size, 1);
    assert.ok(acknowledged.get(id));
    assert.equal(await acknowledgeInvestigation(db, id.toUpperCase()), "acknowledged");
    assert.deepEqual(await listInvestigationAcknowledgements(db, [id]), acknowledged);

    assert.equal(await acknowledgeInvestigation(db, otherId), "not_found");
    assert.equal(await acknowledgeInvestigation(db, "malformed"), "not_found");
    for (const statement of [
      "SELECT * FROM public.investigations",
      "UPDATE public.investigation_acknowledgements SET acknowledged_at=now()",
      "DELETE FROM public.investigation_acknowledgements",
    ]) {
      await assert.rejects(db.query(statement), { code: "42501" });
    }
  });

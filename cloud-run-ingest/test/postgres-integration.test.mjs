import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { archiveBatch } from "../investigation-archive.js";

const dbUrl = process.env.TEST_DATABASE_URL;
test("end-to-end durable archive against disposable PostgreSQL and read API",
  {skip: !dbUrl, timeout: 60000}, async () => {
  const {default: pg} = await import("pg");
  const client = new pg.Client({connectionString:dbUrl});
  await client.connect();
  const migrationRoot=new URL("../../cloud-sql/migrations/", import.meta.url);
  try {
    await client.query(readFileSync(new URL("001_bootstrap.sql",migrationRoot),"utf8"));
    await client.query(readFileSync(new URL("003_durable_investigations.sql",migrationRoot),"utf8"));
    // A rerun should succeed if a deployment was interrupted after migration.
    await client.query(readFileSync(new URL("003_durable_investigations.sql",migrationRoot),"utf8"));
    await client.query("INSERT INTO workspaces (id,name) VALUES ('default','Lab'),('other','Other') ON CONFLICT DO NOTHING");
    const observedAt=new Date().toISOString();
    const sample={workspace_id:"default", signal_type:"trace",service_name:"checkout",
      environment:"lab", severity:"ERROR",status_code:500,message:"POST /checkout",
      trace_id:"fixture-trace-1",span_id:"fixture-span-1",
      attributes:{"http.route":"/checkout","peer.service":"inventory"},
      observed_at:observedAt};
    await client.query("BEGIN");
    await archiveBatch(client,[sample],"default");
    await client.query("COMMIT");
    await client.query("BEGIN");
    await archiveBatch(client,[sample],"default");
    await client.query("COMMIT");
    const count=await client.query(
      "SELECT COUNT(*)::integer AS n FROM investigation_evidence WHERE workspace_id='default'");
    assert.equal(count.rows[0].n,1,"replay must not duplicate source evidence");
    const inv=await client.query(
      "SELECT id FROM investigations WHERE workspace_id='default' LIMIT 1");
    assert.equal(inv.rowCount,1);
    // Composite FK rejects cross-tenant evidence attribution.
    await assert.rejects(
      client.query(`INSERT INTO investigation_evidence
        (workspace_id,investigation_id,source_type,source_event_id,summary)
        VALUES ('other',$1,'trace','cross-tenant','invalid')`,[inv.rows[0].id]),
      /foreign key|violates/i
    );
    const url = new URL(dbUrl);
    const env={...process.env,PORT:"18080",PGHOST:url.hostname,
      PGPORT:url.port||"5432",PGDATABASE:url.pathname.slice(1),
      PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),
      SIGNALDECK_READ_KEY:"ci-only-key",SIGNALDECK_WORKSPACE_ID:"default"};
    const child=spawn(process.execPath,["cloud-run-read-api/server.js"],{
      cwd:new URL("../../",import.meta.url).pathname,env,stdio:"pipe"});
    let errors="";
    child.stderr.on("data",b=>{errors+=String(b)});
    try {
      let ready=false;
      for(let tries=0;tries<60;tries++){
        if(child.exitCode!==null)throw new Error(`read API exited: ${errors}`);
        try{const r=await fetch("http://127.0.0.1:18080/healthz");if(r.ok){ready=true;break}}catch{}
        await delay(100);
      }
      assert.ok(ready,`read API did not become ready: ${errors}`);
      const unauthorized=await fetch("http://127.0.0.1:18080/v1/investigations");
      assert.equal(unauthorized.status,401);
      const headers={Authorization:"Bearer ci-only-key"};
      const list=await fetch("http://127.0.0.1:18080/v1/investigations",{headers});
      assert.equal(list.status,200);
      const rows=await list.json();
      assert.equal(rows.investigations.length,1);
      const detail=await fetch(`http://127.0.0.1:18080/v1/investigations/${inv.rows[0].id}`,{headers});
      assert.equal(detail.status,200);
      const payload=await detail.json();
      assert.equal(payload.evidence.length,1);
      assert.equal(payload.evidence[0].payload.peer_service,"inventory");
    } finally {child.kill("SIGTERM")}
  } finally {await client.end()}
});

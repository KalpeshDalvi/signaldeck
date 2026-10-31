# SignalDeck Milestone 3 — Durable investigation evidence

## Code shipped (not yet deployed)

- `cloud-run-ingest/investigation-archive.js` automatically plans evidence snapshots for HTTP 5xx/OTel error spans, high-severity application logs, Kubernetes warning events, and Deployment snapshots at zero desired replicas.
- Ingest `save()` writes raw telemetry and the investigation/evidence snapshot in **one PostgreSQL transaction**, only when `SIGNALDECK_ARCHIVE_ENABLED=true`. If the archive cannot persist, the batch rolls back and returns a failure: no silent evidence loss.
- A single batch UPSERT and batch evidence INSERT cap DB round trips. Investigation keys group qualifying records per 5-minute service/environment or Kubernetes workload bucket; replayed source events are deduplicated. This is an MVP grouping policy, not a long-lived incident identifier.
- Archive payloads use small allowlisted summaries/fields, truncate/redact obvious token patterns, and exclude full raw attribute maps. Do not assume arbitrary application logs are fully PII-free; implement a configurable redaction policy before production multi-tenant rollout.
- Read API `GET /v1/investigations` and `GET /v1/investigations/:id` are read-only and enforce the service's configured workspace.
- Dashboard `/investigations` and `/investigations/:id` display saved findings and evidence.

**Not implemented:** automatic GKE Cloud Audit Logs enrichment, reliable alerting on capture failure, linking every cross-service error to one canonical incident ID, or auto-confirmation of root cause. A GKE desired-replicas=0 observation does not establish the initiating actor. Milestone 3 does not reconstruct the expired October 22 raw traces.

## Test and validation before infrastructure changes

From Windows PowerShell:

```powershell
cd F:\signaldeck
git pull origin main
node --check .\cloud-run-ingest\server.js
node --check .\cloud-run-ingest\investigation-archive.js
node --check .\cloud-run-read-api\server.js
node --test .\cloud-run-ingest\test\archive.test.mjs
npm.cmd run build
```

Stop if any test fails. Do not enable archiving before applying the migration.

## Step 1: Review/apply the schema

`cloud-sql/migrations/003_durable_investigations.sql` is opt-in, idempotent for a fresh install, and should be reviewed against current schema and backup state.

Using an **already authorized** `psql` session or a Cloud SQL Studio connection with the right database/role, apply the SQL. For a working `psql` connection:

```powershell
psql -v ON_ERROR_STOP=1 -f .\cloud-sql\migrations\003_durable_investigations.sql
```

Do not paste credentials into shell history or ChatGPT. Verify the two tables before enabling ingestion:

```sql
SELECT to_regclass('public.investigations') AS investigations,
       to_regclass('public.investigation_evidence') AS evidence;
```

The existing ingest DB role must have appropriate `SELECT, INSERT, UPDATE` permissions on `investigations` and `INSERT` on `investigation_evidence`; the read API role needs read-only `SELECT` on both. Review roles with a DBA; never grant universal write access or share the dashboard's authenticated read API key with the collector.

## Step 2: Deploy code without changing existing auth/secret settings

Use existing configured Cloud Run services, with the same region/project. Preserve their current environment, service accounts, secrets, and IAM:

```powershell
gcloud.cmd run deploy signaldeck-read-api `
  --project=signaldeck-lab-kd `
  --region=us-central1 `
  --source=.\cloud-run-read-api

gcloud.cmd run deploy signaldeck-ingest `
  --project=signaldeck-lab-kd `
  --region=us-central1 `
  --source=.\cloud-run-ingest
```

Omitting `--allow-unauthenticated` and `--no-allow-unauthenticated` avoids intentionally changing Cloud Run IAM; verify the current invoker policy after deployment. Do **not** enable the new flag yet. Build the dashboard with the same successful Cloud Run deployment command and its existing read API URL, workspace, runtime identity, and secret mapping.

Before enabling, inspect Cloud Run logs for startup failures; confirm the ingest service can still accept valid OTLP batches and the read API's `/ready` check works.

## Step 3: Enable automatic archiving (feature flag)

Only after migration and runtime DB grants are validated:

```powershell
gcloud.cmd run services update signaldeck-ingest `
  --project=signaldeck-lab-kd `
  --region=us-central1 `
  --update-env-vars=SIGNALDECK_ARCHIVE_ENABLED=true
```

This is an explicit opt-in. Normal telemetry ingestion uses its preexisting database path when false; no feature flag is needed for read-only archive access. If an archive insert fails after enabling, the batch will return 503 and roll back, and the collector may retry.

Rollback without deleting any archive data:

```powershell
gcloud.cmd run services update signaldeck-ingest `
  --project=signaldeck-lab-kd `
  --region=us-central1 `
  --update-env-vars=SIGNALDECK_ARCHIVE_ENABLED=false
```

## Step 4: Smoke test and acceptance

- Open `/investigations`: no 503 / unavailable status once schema and read roles are correct. Initially an empty archive is expected.
- Create a **controlled lab-only** failed request or Kubernetes warning, with a documented restoration plan, only after normal ingestion and archive permissions have been verified.
- Confirm the ingester accepts the OTLP batch; the saved investigation appears with an evidence timeline containing the source event ID, event time, capture time, and a causal limitation.
- Replay the same event safely and verify the archive evidence is deduplicated, rather than creating duplicate rows.
- Check a recent healthy transaction does not create a new incident.
- Verify a saved investigation remains readable after raw telemetry retention expires.
- Verify archived read endpoints cannot access another workspace (the server fixes workspace from runtime configuration).
- Record follow-up work: audit-log snapshot capture, active error-log collection, change-origin enrichment, stronger PII redaction, capture alerts, and grouping policies.

The October 22 audit record is still available in Cloud Logging. Do not claim the new archive has retained that incident unless it was explicitly captured; the automatic archive captures only **newly ingested** qualifying evidence after enabling.

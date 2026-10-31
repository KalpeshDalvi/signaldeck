# SignalDeck

SignalDeck is an OpenTelemetry-native observability and incident-investigation prototype built around GKE, Cloud Run, and Cloud SQL PostgreSQL.

## Architecture

- **GKE lab workloads:** checkout, inventory, and a traffic generator.
- **OpenTelemetry Collector:** OTLP traces and Kubernetes object/event telemetry.
- **Cloud Run `signaldeck-ingest`:** validates incoming telemetry and writes to Cloud SQL.
- **Cloud SQL PostgreSQL:** raw `telemetry_events`, with an optional independent investigation archive.
- **Cloud Run `signaldeck-read-api`:** authenticated, workspace-scoped telemetry and archive retrieval.
- **Cloud Run `signaldeck-dashboard`:** service health, traces, Kubernetes, alerts, incident correlation, historical audit investigation, and saved investigations.
- **GKE Cloud Audit Logs:** read-only investigation of Deployment changes and authenticated API operations.

## Development status

**Working in the lab:** distributed checkout-to-inventory tracing; Kubernetes state views; evidence-driven correlation hypotheses; historical GKE scale-to-zero API investigation, initiating identity, and prevention suggestions.

**Milestone 3 (code written, rollout pending):** automatically preserve newly ingested error spans, high-severity application logs (if collected), zero-replica Deployment snapshots (if observed), and Kubernetes warning events to a durable investigation/evidence archive. The feature is disabled until the migration is applied and `SIGNALDECK_ARCHIVE_ENABLED=true` is configured.

**Not yet complete:** automatic Cloud Audit Logs snapshots into the durable archive, incident grouping across long-running outages, verified AI root-cause analysis, comprehensive error-log collection, production-grade tenant isolation/retention/PII controls, and proactive user notifications.

The archive preserves only qualifying events **received after it is enabled**; it cannot restore expired October 22 raw telemetry.

## Build and test (PowerShell)

```powershell
cd F:\signaldeck
node --check .\cloud-run-ingest\server.js
node --check .\cloud-run-ingest\investigation-archive.js
node --check .\cloud-run-read-api\server.js
node --test .\cloud-run-ingest\test\archive.test.mjs
npm.cmd run build
```

Detailed migration and deployment instructions: [Milestone 3 deployment runbook](docs/milestone-3-deployment.md).

## Raw telemetry retention

`cloud-sql/migrations/002_telemetry_retention.sql` defines a seven-day cleanup procedure, but defining a procedure is not proof it was scheduled or executed. `cloud-sql/migrations/003_durable_investigations.sql` defines an independently retained archive schema. Migrations are not applied automatically.

## Primary product goal

Detect the symptom, retrieve relevant application/dependency/infrastructure evidence, reconstruct a verifiable cause chain, identify initiating changes, and recommend an immediate recovery plus a separately validated recurrence-prevention measure. Clearly label unverified hypotheses and missing evidence; never claim causality merely because events overlap in time.

# Historical telemetry coverage: query timeout and retention triage

## Observed failure (2026-10-31)
The deployed read API reported:
- `GET /v1/coverage`: HTTP 503 after ~8.007 seconds.
- PostgreSQL stderr: `canceling statement due to statement timeout`.
- Historical incident: `2026-10-22T17:29:08Z`, raw telemetry returned zero records.
- GKE audit records *were* available, proving a scale API request of 0 replicas followed by 1 replica.

The 8-second timeout proves the diagnostic query timed out, **not** that telemetry was deleted or that Cloud SQL is unavailable. The seven-day `cleanup_old_telemetry` SQL procedure is present in the repository but is not evidence that it was scheduled or run.

## Read API mitigation
The `/v1/coverage` endpoint must avoid a full-table aggregation. It now reads the PostgreSQL index catalog first. If the expected ready/valid `(workspace_id, signal_type, observed_at)` btree index is absent, it returns an `index_missing` diagnostic and does not probe historical rows. When indexed, the endpoint performs per-signal EXISTS and indexed first/last row reads, each capped by a 1,200-ms read-only transaction timeout.

- `found`: at least one matching row was returned.
- `not_found`: no matching row in this workspace/time window (when the probe completed).
- `timed_out` or `unavailable`: historical data presence unknown, **never display zero**.
- `index_missing`: inspect database index health; do not guess retention.

## DBA verification (read-only)
Run using an authorized PostgreSQL connection:

```sql
SELECT idx.relname AS index_name, i.indisvalid, i.indisready,
       pg_get_indexdef(idx.oid) AS definition
FROM pg_index i
JOIN pg_class idx ON idx.oid = i.indexrelid
JOIN pg_class tbl ON tbl.oid = i.indrelid
JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname='public' AND tbl.relname='telemetry_events';

SELECT relname, n_live_tup, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname='public' AND relname='telemetry_events';
```

The bootstrap migration declares `telemetry_workspace_type_time_idx` on `(workspace_id,signal_type,observed_at DESC)`, but **do not assume the live database has that index**. If it is missing, plan a separate, reviewed, off-peak `CREATE INDEX CONCURRENTLY` operation with an authorized migration role and sufficient free storage. If the index exists but is invalid, `IF NOT EXISTS` will not repair it; inspect/rebuild deliberately.

## Verify retention separately
Check for job scheduler configuration and any application/cron automation actually executing `CALL public.cleanup_old_telemetry(...)`. If raw telemetry has expired, do not fabricate it from Kubernetes audit records: preserve historical audit findings and label application-impact evidence as unavailable.

For SaaS readiness, add durable incident summaries/evidence snapshots separately from short-retention raw telemetry. Historical RCA must be replayable weeks later without storing every span indefinitely.

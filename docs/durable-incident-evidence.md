# SignalDeck durable investigation evidence (MVP next milestone)

## Why this is required

On 2026-10-22 at ~17:29 UTC, a checkout request failed while inventory had been scaled to zero. On 2026-10-31, the historical telemetry existence checks for the 16:59–17:59 UTC window returned **not_found** for traces, logs, metrics, and Kubernetes events in the configured workspace. GKE Cloud Audit Logs still contained the initiating `deployments.scale.patch` requests (0 replicas, then 1).

This demonstrates the need to preserve incident-specific findings and their supporting evidence separately from short-retention raw telemetry. It does not establish why raw data was missing; the existence of the seven-day `cleanup_old_telemetry` procedure is not proof that a retention job ran.

## Current limitation

`lib/incidents.ts` falls back to an in-process `memoryStore` unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured. On Cloud Run this is ephemeral and must not be relied upon as permanent incident storage. The separate Postgres read API has read-only behavior and is not an authorized evidence writer.

## Storage contract

`cloud-sql/migrations/003_durable_investigations.sql` creates:

- `public.investigations`: a workspace-scoped incident record, hypothesis, independently verified mechanism, initiating change and actor, recovery, prevention, validation, and limitations;
- `public.investigation_evidence`: source-attributed, idempotent evidence snapshots with original source event ID and time, collection time, resource, summary, and bounded JSON payload.

Both tables reference `workspaces`; a composite FK prevents evidence being attached across workspace boundaries.

**Migration is not applied automatically.** Review using a dedicated migration database role; confirm backup/recovery and access before applying. The two tables do not change the raw-telemetry retention procedure.

## Implementation sequence (not yet complete)

1. Apply the migration with a reviewed, authorized database migration process.
2. Create a separate evidence-writer endpoint on the ingestion service (or a dedicated investigator service), protected by Cloud Run IAM and workspace-scoped authorization. The dashboard's read-only API must not acquire write privileges.
3. Capture an evidence snapshot *when an incident is detected*, while raw traces and logs still exist: failing root span, dependency spans, error excerpts with redaction, Kubernetes state transitions, related GKE audit change events, and source event IDs.
4. Upsert a stable incident key, deduplicate evidence on `(investigation_id,source_type,source_event_id)`, and store structured findings with certainty levels:
   - observed symptom;
   - corroborated failure mechanism;
   - initiating API operation/actor;
   - upstream cause still unknown, if audit does not establish intention or workflow.
5. Display saved historical investigations even when the underlying raw telemetry has expired. Add evidence citations, record freshness, and “not independently verified” wording where appropriate.
6. Apply and test a separate retention policy for investigation/evidence records (e.g., 90–365 days), with customer-specific access, retention and deletion controls.

No AI should invent missing log contents, timestamps, actors, or causation. A verified audit scale request can support a Kubernetes change finding; a checkout HTTP 500 correlation requires a contemporaneous application trace, log, or other direct application evidence.

## Acceptance criteria

- Future real or lab incident is captured into the durable tables within minutes, before raw retention deletion.
- Read-only dashboard queries work for the correct workspace, cannot read another workspace, and do not mutate evidence.
- A historical incident remains reconstructable after raw telemetry is deleted.
- Investigation shows both the confirmed initiating operation and the limitations of causal evidence.
- A failed snapshot write is visible as an error/alert; no “saved” success is displayed falsely.
- PostgreSQL index/statement-timeout errors are surfaced separately from genuinely absent historical rows.

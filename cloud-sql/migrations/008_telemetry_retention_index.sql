-- Run as the migration owner outside a transaction after explicit rollout approval.
CREATE INDEX CONCURRENTLY IF NOT EXISTS telemetry_workspace_ingested_idx
  ON public.telemetry_events (workspace_id, created_at, id);

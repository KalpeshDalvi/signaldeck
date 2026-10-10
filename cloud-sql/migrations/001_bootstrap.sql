-- SignalDeck Cloud SQL PostgreSQL bootstrap (fresh database only).
-- Apply with psql using a dedicated migration role. Never expose DB credentials to browsers.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  cloud_provider text NOT NULL DEFAULT 'gcp',
  project_id text,
  cluster_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,name)
);
CREATE TABLE IF NOT EXISTS ingestion_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('log','trace','metric','k8s_event')),
  service_name text NOT NULL,
  environment text NOT NULL DEFAULT 'unknown',
  severity text,
  message text NOT NULL DEFAULT '',
  trace_id text,
  span_id text,
  parent_span_id text,
  duration_ms double precision,
  status_code integer,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telemetry_workspace_time_idx ON telemetry_events(workspace_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_workspace_service_time_idx ON telemetry_events(workspace_id,service_name,observed_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_workspace_type_time_idx ON telemetry_events(workspace_id,signal_type,observed_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_trace_idx ON telemetry_events(workspace_id,trace_id) WHERE trace_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  service_name text NOT NULL,
  environment text NOT NULL DEFAULT 'unknown',
  severity text NOT NULL CHECK (severity IN ('SEV-1','SEV-2','SEV-3')),
  status text NOT NULL CHECK (status IN ('detected','investigating','mitigated','resolved')),
  owner text,
  summary text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  mitigated_at timestamptz,
  resolved_at timestamptz,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS incidents_workspace_status_idx ON incidents(workspace_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS incidents_service_idx ON incidents(workspace_id,service_name,environment,updated_at DESC);
COMMIT;
-- Next migration must add incident_notes and deployment evidence after compatibility review.
-- Production rollout must enforce authenticated workspace scope in API queries,
-- use separate least-privilege DB roles, and implement retention before enabling ingest.

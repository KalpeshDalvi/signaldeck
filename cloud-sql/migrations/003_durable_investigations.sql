-- SignalDeck: durable, workspace-scoped investigation/evidence storage.
-- Requires existing workspaces table and pgcrypto from 001_bootstrap.sql.
-- REVIEW BEFORE EXECUTION: migration does not execute automatically.
-- Retention is independent of raw telemetry cleanup (002).
BEGIN;

CREATE TABLE IF NOT EXISTS public.investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  incident_key text NOT NULL,
  incident_at timestamptz NOT NULL,
  environment text NOT NULL DEFAULT 'unknown',
  impacted_service text,
  suspected_dependency text,
  status text NOT NULL DEFAULT 'investigating'
    CHECK (status IN ('investigating','mitigated','resolved','incomplete')),
  hypothesis text,
  verified_mechanism text,
  initiating_change text,
  initiating_actor text,
  initiating_actor_type text,
  immediate_recovery text,
  recurrence_prevention text,
  verification_plan text,
  limitations text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investigations_workspace_incident_unique UNIQUE (workspace_id, incident_key)
);

CREATE INDEX IF NOT EXISTS investigations_workspace_time_idx
  ON public.investigations(workspace_id, incident_at DESC);

CREATE TABLE IF NOT EXISTS public.investigation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  investigation_id uuid NOT NULL REFERENCES public.investigations(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN (
    'trace','application_log','k8s_event','k8s_audit','deployment_change','metric','operator_note'
  )),
  source_event_id text NOT NULL,
  source_event_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT now(),
  resource_name text,
  summary text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT investigation_evidence_source_unique
    UNIQUE (investigation_id, source_type, source_event_id)
);

CREATE INDEX IF NOT EXISTS investigation_evidence_timeline_idx
  ON public.investigation_evidence(investigation_id,source_event_at);
CREATE INDEX IF NOT EXISTS investigation_evidence_workspace_idx
  ON public.investigation_evidence(workspace_id,investigation_id);

-- Ensure a row's workspace agrees with its parent investigation.
-- PostgreSQL does not infer this from separate foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS investigations_id_workspace_uix
  ON public.investigations(id,workspace_id);
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='investigation_evidence_same_workspace'
      AND conrelid='public.investigation_evidence'::regclass
  ) THEN
    ALTER TABLE public.investigation_evidence
      ADD CONSTRAINT investigation_evidence_same_workspace
      FOREIGN KEY (investigation_id,workspace_id)
      REFERENCES public.investigations(id,workspace_id);
  END IF;
END
$migration$;

COMMIT;

-- RUNTIME ACCESS REQUIREMENTS (DO NOT GRANT IN THIS MIGRATION):
-- Investigation writer: restricted INSERT/UPDATE on investigations and INSERT
-- on evidence for only authorized workspaces, enforced in the API.
-- Dashboard reader: scoped SELECT, never UPDATE or DELETE raw evidence.
-- Never use the Cloud Run dashboard IAP identity to bypass workspace scopes.
-- Retention: create explicit policy for investigations/evidence (e.g. 90-365d),
-- with appropriate legal/contractual retention requirements.

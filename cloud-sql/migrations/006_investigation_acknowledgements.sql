-- Apply as the migration owner after 003_durable_investigations.sql and 005.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

CREATE TABLE IF NOT EXISTS public.investigation_acknowledgements (
  workspace_id text NOT NULL,
  investigation_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, investigation_id),
  FOREIGN KEY (investigation_id, workspace_id)
    REFERENCES public.investigations(id, workspace_id) ON DELETE CASCADE
);

REVOKE ALL ON public.investigation_acknowledgements FROM PUBLIC;
GRANT SELECT, INSERT (workspace_id, investigation_id)
  ON public.investigation_acknowledgements TO signaldeck_incident_writer;

COMMIT;

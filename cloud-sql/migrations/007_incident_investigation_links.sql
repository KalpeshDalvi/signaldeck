-- Apply after 003 and 005 as the migration owner.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

CREATE UNIQUE INDEX IF NOT EXISTS incidents_id_workspace_uix
  ON public.incidents(id, workspace_id);

CREATE TABLE IF NOT EXISTS public.incident_investigation_links (
  workspace_id text NOT NULL,
  investigation_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, investigation_id),
  FOREIGN KEY (incident_id, workspace_id)
    REFERENCES public.incidents(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (investigation_id, workspace_id)
    REFERENCES public.investigations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incident_investigation_links_incident_idx
  ON public.incident_investigation_links(workspace_id, incident_id);

REVOKE ALL ON public.incident_investigation_links FROM PUBLIC;
GRANT SELECT, INSERT ON public.incident_investigation_links TO signaldeck_incident_writer;
COMMIT;

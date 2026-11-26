-- Apply to the SignalDeck database after 001_bootstrap.sql as the database owner.
-- Provision the login password separately through the runtime secret.
BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'signaldeck_incident_writer') THEN
    CREATE ROLE signaldeck_incident_writer LOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO signaldeck_incident_writer', current_database());
END;
$role$;

GRANT USAGE ON SCHEMA public TO signaldeck_incident_writer;
GRANT SELECT ON public.incidents TO signaldeck_incident_writer;
GRANT INSERT (workspace_id, title, service_name, environment, severity, status, summary)
  ON public.incidents TO signaldeck_incident_writer;
GRANT UPDATE (title, status, owner, severity, summary, notes, updated_at, mitigated_at, resolved_at)
  ON public.incidents TO signaldeck_incident_writer;

COMMIT;

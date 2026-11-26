-- Run in signaldeck as the archive table owner. A dedicated Secret Manager
-- credential is provisioned after the role and grants have been verified.
BEGIN;

DO $check$
BEGIN
  IF current_database() <> 'signaldeck' THEN
    RAISE EXCEPTION 'Expected database signaldeck';
  END IF;
  IF to_regclass('public.investigations') IS NULL
     OR to_regclass('public.investigation_evidence') IS NULL THEN
    RAISE EXCEPTION 'Archive tables are required';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'signaldeck_investigator') THEN
    CREATE ROLE signaldeck_investigator LOGIN;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles r
    LEFT JOIN pg_auth_members membership ON membership.member = r.oid
    WHERE r.rolname = 'signaldeck_investigator'
      AND (NOT r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb
           OR r.rolreplication OR r.rolbypassrls OR membership.roleid IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Expected a dedicated unprivileged investigator login';
  END IF;
END;
$check$;

GRANT CONNECT ON DATABASE signaldeck TO signaldeck_investigator;
GRANT USAGE ON SCHEMA public TO signaldeck_investigator;
GRANT SELECT ON public.investigations, public.investigation_evidence
  TO signaldeck_investigator;
GRANT UPDATE (hypothesis, verified_mechanism, initiating_change, initiating_actor,
  initiating_actor_type, immediate_recovery, recurrence_prevention, verification_plan,
  limitations, updated_at) ON public.investigations TO signaldeck_investigator;
GRANT INSERT (workspace_id, investigation_id, source_type, source_event_id,
  source_event_at, resource_name, summary, payload)
  ON public.investigation_evidence TO signaldeck_investigator;

DO $check$
BEGIN
  IF has_schema_privilege('signaldeck_investigator', 'public', 'CREATE')
     OR has_any_column_privilege('signaldeck_investigator', 'public.telemetry_events', 'SELECT,INSERT,UPDATE')
     OR has_table_privilege('signaldeck_investigator', 'public.telemetry_events', 'DELETE,TRUNCATE')
     OR has_any_column_privilege('signaldeck_investigator', 'public.investigations', 'INSERT')
     OR has_table_privilege('signaldeck_investigator', 'public.investigations', 'UPDATE,DELETE,TRUNCATE')
     OR has_any_column_privilege('signaldeck_investigator', 'public.investigation_evidence', 'UPDATE')
     OR has_table_privilege('signaldeck_investigator', 'public.investigation_evidence', 'INSERT,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'Investigator has privileges beyond the expected archive grants';
  END IF;
END;
$check$;

COMMIT;

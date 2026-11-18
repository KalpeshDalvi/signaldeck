-- SignalDeck Milestone 3: runtime permissions for archived investigations.
-- Run ONLY after 003_durable_investigations.sql has completed successfully.
-- Execute in the signaldeck database as postgres or another authorized DB owner.
-- This file changes grants; it never modifies existing application data.
BEGIN;

DO $check$
BEGIN
  IF current_database() <> 'signaldeck' THEN
    RAISE EXCEPTION 'Expected database signaldeck; connected to %', current_database();
  END IF;
  IF to_regclass('public.investigations') IS NULL
     OR to_regclass('public.investigation_evidence') IS NULL THEN
    RAISE EXCEPTION 'Missing migration 003 archive tables; run and verify migration 003 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'signaldeck_ingest')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'signaldeck_reader') THEN
    RAISE EXCEPTION 'Required runtime database roles are missing';
  END IF;
END;
$check$;

-- Both roles need schema USAGE, but no CREATE privilege.
GRANT USAGE ON SCHEMA public TO signaldeck_ingest, signaldeck_reader;

-- The ingest service upserts investigations with RETURNING id/incident_key.
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.investigations TO signaldeck_ingest;

-- The ingest service only appends deduplicated evidence, never changes it.
GRANT INSERT
  ON TABLE public.investigation_evidence TO signaldeck_ingest;

-- Separate read-only API role; no write grants.
GRANT SELECT
  ON TABLE public.investigations, public.investigation_evidence
  TO signaldeck_reader;

COMMIT;

-- Verification: all expected permissions must be true.
SELECT current_database() AS db,
  has_table_privilege('signaldeck_ingest','public.investigations','SELECT') AS ingest_inv_read,
  has_table_privilege('signaldeck_ingest','public.investigations','INSERT') AS ingest_inv_insert,
  has_table_privilege('signaldeck_ingest','public.investigations','UPDATE') AS ingest_inv_update,
  has_table_privilege('signaldeck_ingest','public.investigation_evidence','INSERT') AS ingest_evidence_insert,
  has_table_privilege('signaldeck_reader','public.investigations','SELECT') AS reader_inv_select,
  has_table_privilege('signaldeck_reader','public.investigation_evidence','SELECT') AS reader_evidence_select,
  has_table_privilege('signaldeck_reader','public.investigations','INSERT') AS reader_inv_insert_should_be_false,
  has_schema_privilege('signaldeck_ingest','public','CREATE') AS ingest_create_should_be_false;

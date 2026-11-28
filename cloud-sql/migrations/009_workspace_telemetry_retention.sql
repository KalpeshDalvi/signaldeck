-- Run only after verifying the retention index from migration 008 is valid.
BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_workspace_telemetry(
    target_workspace text,
    retention_days integer DEFAULT 7,
    batch_size integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
    deleted_rows integer;
BEGIN
    IF target_workspace IS NULL OR btrim(target_workspace) = '' THEN
        RAISE EXCEPTION 'target_workspace is required' USING ERRCODE = '22023';
    END IF;
    IF retention_days IS NULL OR retention_days NOT BETWEEN 1 AND 365 THEN
        RAISE EXCEPTION 'retention_days must be between 1 and 365' USING ERRCODE = '22023';
    END IF;
    IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'batch_size must be between 1 and 5000' USING ERRCODE = '22023';
    END IF;

    WITH batch AS (
        SELECT id
        FROM public.telemetry_events
        WHERE workspace_id = target_workspace
          AND created_at < statement_timestamp() - make_interval(hours => 24 * retention_days)
        ORDER BY created_at, id
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.telemetry_events AS raw
    USING batch
    WHERE raw.workspace_id = target_workspace AND raw.id = batch.id;

    GET DIAGNOSTICS deleted_rows = ROW_COUNT;
    RETURN deleted_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_workspace_telemetry(text, integer, integer) FROM PUBLIC;

COMMIT;

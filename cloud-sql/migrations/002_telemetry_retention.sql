-- SignalDeck: seven-day telemetry retention procedure.
-- Scheduling and maintenance-role permissions are configured separately.

CREATE OR REPLACE PROCEDURE public.cleanup_old_telemetry(
    retention_days integer DEFAULT 7
)
LANGUAGE plpgsql
AS $$
BEGIN
    IF retention_days IS NULL
       OR retention_days < 1
       OR retention_days > 365 THEN
        RAISE EXCEPTION 'retention_days must be between 1 and 365';
    END IF;

    DELETE FROM public.telemetry_events
    WHERE created_at < NOW() - make_interval(days => retention_days);
END;
$$;
alter table public.telemetry_events
  add column if not exists parent_span_id text;

create index if not exists telemetry_events_trace_parent_idx
  on public.telemetry_events (workspace_id, trace_id, parent_span_id)
  where trace_id is not null;

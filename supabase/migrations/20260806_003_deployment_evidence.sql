alter table public.telemetry_events drop constraint if exists telemetry_events_signal_type_check;

alter table public.telemetry_events
  add constraint telemetry_events_signal_type_check
  check (signal_type in ('log', 'trace', 'metric', 'k8s_event', 'deployment'));

create index if not exists telemetry_events_deployment_idx
  on public.telemetry_events (workspace_id, service_name, environment, observed_at desc)
  where signal_type = 'deployment';

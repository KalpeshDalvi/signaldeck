create extension if not exists pgcrypto;

create table if not exists public.telemetry_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default 'default',
  signal_type text not null check (signal_type in ('log', 'trace', 'metric', 'k8s_event')),
  service_name text not null,
  environment text not null default 'unknown',
  severity text,
  message text not null default '',
  trace_id text,
  span_id text,
  duration_ms double precision,
  status_code integer,
  attributes jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists telemetry_events_observed_at_idx on public.telemetry_events (observed_at desc);
create index if not exists telemetry_events_service_idx on public.telemetry_events (workspace_id, service_name, observed_at desc);
create index if not exists telemetry_events_signal_idx on public.telemetry_events (workspace_id, signal_type, observed_at desc);
create index if not exists telemetry_events_trace_idx on public.telemetry_events (trace_id) where trace_id is not null;

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default 'default',
  title text not null,
  service_name text not null,
  environment text not null default 'unknown',
  severity text not null check (severity in ('SEV-1', 'SEV-2', 'SEV-3')),
  status text not null check (status in ('detected', 'investigating', 'mitigated', 'resolved')),
  owner text,
  summary text not null default '',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  mitigated_at timestamptz,
  resolved_at timestamptz,
  notes jsonb not null default '[]'::jsonb
);

create index if not exists incidents_workspace_status_idx on public.incidents (workspace_id, status, updated_at desc);
create index if not exists incidents_service_idx on public.incidents (workspace_id, service_name, environment, updated_at desc);

alter table public.telemetry_events enable row level security;
alter table public.incidents enable row level security;

-- The application backend writes with SUPABASE_SERVICE_ROLE_KEY.
-- Browser clients should never receive that key. User-facing RLS policies
-- will be added when workspace membership and authentication are introduced.

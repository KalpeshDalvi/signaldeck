create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.environments (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null,
  cloud_provider text not null default 'gcp',
  project_id text,
  cluster_name text,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.ingestion_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.telemetry_events
  add constraint telemetry_events_workspace_fk
  foreign key (workspace_id) references public.workspaces(id) on delete cascade
  not valid;

alter table public.incidents
  add constraint incidents_workspace_fk
  foreign key (workspace_id) references public.workspaces(id) on delete cascade
  not valid;

create index if not exists environments_workspace_idx on public.environments(workspace_id);
create index if not exists ingestion_keys_workspace_idx on public.ingestion_keys(workspace_id);
create index if not exists incidents_workspace_status_idx on public.incidents(workspace_id, status, updated_at desc);

alter table public.workspaces enable row level security;
alter table public.environments enable row level security;
alter table public.ingestion_keys enable row level security;

-- The MVP server uses the service-role key. Browser-facing membership policies
-- will be introduced with authentication. Until then, every server query must
-- include workspace_id explicitly; lib/telemetry.ts and lib/incidents.ts enforce it.

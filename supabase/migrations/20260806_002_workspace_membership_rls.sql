create table if not exists public.workspace_members (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','responder','viewer','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
alter table public.workspace_members enable row level security;

create policy "members can view their memberships"
on public.workspace_members for select
to authenticated
using (user_id = auth.uid());

create policy "members can view workspaces"
on public.workspaces for select
to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = workspaces.id and wm.user_id = auth.uid()
));

create policy "members can view environments"
on public.environments for select
to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = environments.workspace_id and wm.user_id = auth.uid()
));

create policy "members can view telemetry"
on public.telemetry_events for select
to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = telemetry_events.workspace_id and wm.user_id = auth.uid()
));

create policy "members can view incidents"
on public.incidents for select
to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = incidents.workspace_id and wm.user_id = auth.uid()
));

create policy "responders can update incidents"
on public.incidents for update
to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = incidents.workspace_id
    and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','responder')
))
with check (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = incidents.workspace_id
    and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','responder')
));

create policy "admins can view ingestion key metadata"
on public.ingestion_keys for select
to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = ingestion_keys.workspace_id
    and wm.user_id = auth.uid()
    and wm.role in ('owner','admin')
));
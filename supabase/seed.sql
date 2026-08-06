insert into public.workspaces (id, name)
values ('billpay', 'BillPay Platform')
on conflict (id) do update set name = excluded.name;

insert into public.environments (workspace_id, name, cloud_provider, project_id, cluster_name)
values (
  'billpay',
  'dev',
  'gcp',
  'pid-gousgnad-robi-billpay-6416',
  'guenq-gke-robi-billpay'
)
on conflict (workspace_id, name) do update set
  cloud_provider = excluded.cloud_provider,
  project_id = excluded.project_id,
  cluster_name = excluded.cluster_name;

# SignalDeck incident evidence collection (GKE lab)

## Why the October 22 checkout outage was not fully diagnosed

The downstream failure was reproduced at 2026-10-22 17:29:08 UTC: `POST /checkout` returned HTTP 500 after inventory was scaled down. Inventory was restored promptly.

The collector startup log showed **deployments: mode=pull**. A short Deployment scale-to-zero transition can be missed between pull intervals. Existing Kubernetes Event records can also remain in storage well after an incident. Neither recurring observations nor a high correlation score proves an initiating root cause.

## Collect workload transitions using Kubernetes watch

First inspect the in-cluster configuration; do not replace the existing exporters, receivers, secrets, or pipelines:

```powershell
kubectl.exe get deployment signaldeck-collector -n signaldeck-system -o yaml
kubectl.exe get configmaps -n signaldeck-system
```

Back up the relevant ConfigMap before editing:

```powershell
kubectl.exe get configmap <COLLECTOR_CONFIGMAP> -n signaldeck-system -o yaml > collector-configmap-before-watch.yaml
```

Change the **existing** `deployments` object within the `k8sobjects` receiver from `mode: pull` to `mode: watch`. Keep the namespace scope to `signaldeck-lab` and existing authentication and pipeline settings. Example receiver object:

```yaml
- name: deployments
  mode: watch
  namespaces: [signaldeck-lab]
  include_initial_state: true
```

Check the collector service account has `get`, `list` and `watch` privileges for `apps/deployments`. Then restart only the collector Deployment, verify rollout, and confirm it logs `mode: watch` for Deployments before another controlled fault. Avoid a rolling failure test until this check passes. Watch mode captures changes; `include_initial_state` emits a startup snapshot, which is not a historical backfill.

```powershell
kubectl.exe rollout restart deployment/signaldeck-collector -n signaldeck-system
kubectl.exe rollout status deployment/signaldeck-collector -n signaldeck-system --timeout=120s
kubectl.exe logs deployment/signaldeck-collector -n signaldeck-system --since=10m
```

## Identify *who or what* initiated a scale operation

GKE API-server Kubernetes audit logs use `protoPayload.serviceName="k8s.io"` and `resource.type="k8s_cluster"`. Query the incident time in UTC:

```powershell
gcloud.cmd logging read `
  'resource.type=k8s_cluster AND protoPayload.serviceName=k8s.io AND protoPayload.resourceName:inventory' `
  --project=signaldeck-lab-kd `
  --freshness=1d `
  --limit=100 `
  --format="table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail,protoPayload.resourceName)"
```

If no entries appear, widen the query by removing the `protoPayload.resourceName` filter and inspect nearby Kubernetes API writes. Audit records may be absent, subject to retention, or redacted; do not invent actors or instructions.

For a real agent, ingest scoped audit/change evidence with principal, method, target, time, and relevant old/new values, then link those records to the workload state change and failed trace IDs. Keep access read-only and workspace-scoped.

## Missing application errors

Kubernetes object logs are **not** application stdout/stderr. The current collector configuration must also collect application error logs, either via a separately configured collector receiver or a constrained Cloud Logging reader. A request timeout without exception logs cannot establish whether the failure was DNS, connection refusal, application timeout, or another mechanism.

## Acceptance criteria

- A controlled replica change is captured in watch-mode telemetry before and after the change.
- A failed request trace links the impacted service to the affected dependency.
- A GKE audit record (where available) identifies the initiating operation and actor.
- SignalDeck distinguishes verified cause, working hypothesis, and missing evidence.
- It recommends both a safe immediate recovery and an auditable recurrence-prevention measure.

## Audit-backed investigation in the SignalDeck dashboard

The dashboard now has a bounded, read-only lookup using its Cloud Run runtime service account, via `POST https://logging.googleapis.com/v2/entries:list`. No user passwords, Kubernetes admin token, or static API key are involved. Only audit records targeting a suspected Deployment in the configured namespace and near the most recently observed failed request are retrieved. An audit method and principal identify an initiating *API operation*, not necessarily the root configuration decision or the actual replica value unless the request payload contains it.

Set the dashboard's configuration (preserve its existing read API URL, workspace, and secret settings):

- `SIGNALDECK_GCP_PROJECT_ID=signaldeck-lab-kd`
- `SIGNALDECK_GKE_NAMESPACE=signaldeck-lab`
- `SIGNALDECK_GKE_CLUSTER=signaldeck-lab` (optional, but reduces cross-cluster matches)

The Cloud Run identity needs `logging.logEntries.list` on the target project or a properly scoped log view. If the page reports `permission_denied`, the project administrator can temporarily grant `roles/logging.viewer` to the lab dashboard service account for testing:

```powershell
gcloud.cmd projects add-iam-policy-binding signaldeck-lab-kd `
  --member="serviceAccount:signaldeck-dashboard-runtime@signaldeck-lab-kd.iam.gserviceaccount.com" `
  --role="roles/logging.viewer"
```

**Security note:** A project-level Logging Viewer role can read more logs than SignalDeck needs. Before multi-tenant deployment, replace this lab configuration with a dedicated investigation identity and fine-grained log-view authorization. Do not grant `roles/owner`, `roles/editor`, or Kubernetes mutation privileges to the RCA investigator. Do not expose GKE audit data to unauthorized workspaces. If IAM cannot be granted, leave it unmodified: the page should display `permission_denied` and continue rendering trace diagnostics.

Observed lab audit sequence (UTC, October 22, 2026):

- 17:28:53.739 — `io.k8s.apps.v1.deployments.scale.patch` on `inventory/scale` by the authenticated test identity.
- 17:28:53.932 — ReplicaSet controller deleted the inventory pod.
- 17:29:08 — Controlled checkout POST returned HTTP 500.
- 17:29:13.673 — A second `deployments.scale.patch` restored the Deployment.
- 17:29:13.827 — ReplicaSet controller created the replacement inventory pod.
- 17:29:32.518 — EndpointSlice controller updated inventory endpoints.

An audit timeline demonstrates what was changed, who requested the API operation and what happened afterward. It does not establish the human intent or upstream process responsible for issuing the request. SignalDeck should explicitly preserve that distinction.

Verification: after rebuilding and deploying the dashboard, open `/correlation?minutes=360`. The Kubernetes audit section should show the scale operations if the runtime identity is authorized and Cloud Logging retains the entries. A lack of results is not equivalent to proof that no scale operation happened.

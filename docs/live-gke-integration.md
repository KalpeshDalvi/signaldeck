# Live GKE integration

This milestone connects one non-production GKE cluster to the hosted SignalDeck OTLP/HTTP endpoints.

## Scope of the first rollout

The first collector deployment intentionally does only three things:

1. Receives OTLP traces, metrics, and logs from applications.
2. Watches Kubernetes events, pods, and deployments through read-only RBAC.
3. Exports the evidence to the hosted SignalDeck API.

It does not scrape every container log or kubelet metric yet. Those are added after this gateway path is validated.

## Target cluster

Use a non-production cluster first. Update these placeholders in `deploy/gke/signaldeck-otel-collector.yaml`:

- `REPLACE_GKE_CLUSTER_NAME`
- `REPLACE_GCP_PROJECT_ID`
- `deployment.environment` if the target is not `dev`

## 1. Configure kubectl

```powershell
gcloud container clusters get-credentials <CLUSTER_NAME> `
  --region <REGION> `
  --project <PROJECT_ID>

kubectl config current-context
```

Confirm this is the intended non-production cluster before continuing.

## 2. Create the ingestion secret

Use the same `SIGNALDECK_INGESTION_KEY` configured in Vercel. Do not commit it to Git.

```powershell
kubectl create namespace signaldeck-system --dry-run=client -o yaml | kubectl apply -f -

kubectl -n signaldeck-system create secret generic signaldeck-ingestion `
  --from-literal=ingestion-key="<YOUR_SIGNALDECK_INGESTION_KEY>" `
  --dry-run=client -o yaml | kubectl apply -f -
```

## 3. Apply the collector

```powershell
kubectl apply -f deploy/gke/signaldeck-otel-collector.yaml
kubectl -n signaldeck-system rollout status deployment/signaldeck-collector
```

## 4. Verify collector health

```powershell
kubectl -n signaldeck-system get pods,svc
kubectl -n signaldeck-system logs deployment/signaldeck-collector --tail=100
```

Expected behavior:

- one collector pod is `Running` and `Ready`
- no repeated `401`, `400`, DNS, TLS, or exporter retry errors
- Kubernetes object events begin reaching SignalDeck as logs

## 5. Verify hosted ingestion

Open:

- `https://signaldeck-mauve.vercel.app/logs`
- `https://signaldeck-mauve.vercel.app/kubernetes`
- `https://signaldeck-mauve.vercel.app/incidents`

Create a harmless Kubernetes event to validate the pipeline:

```powershell
kubectl -n signaldeck-system annotate deployment signaldeck-collector `
  signaldeck.io/verification="$(Get-Date -Format o)" --overwrite
```

A deployment modification event should arrive through the collector.

## 6. Point one instrumented workload at the collector

For OTLP/gRPC:

```yaml
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://signaldeck-collector.signaldeck-system.svc.cluster.local:4317
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: grpc
- name: OTEL_SERVICE_NAME
  value: checkout-api
- name: OTEL_RESOURCE_ATTRIBUTES
  value: deployment.environment=dev,service.namespace=billpay
```

For OTLP/HTTP:

```yaml
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://signaldeck-collector.signaldeck-system.svc.cluster.local:4318
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: http/protobuf
```

Restart only the selected non-production workload and verify new traces in SignalDeck.

## Rollback

```powershell
kubectl delete -f deploy/gke/signaldeck-otel-collector.yaml
kubectl delete namespace signaldeck-system
```

## Security characteristics

- read-only Kubernetes RBAC
- ingestion key stored in a Kubernetes Secret
- outbound HTTPS only to the hosted SignalDeck endpoint
- no GCP service-account key required
- no public Kubernetes Service or LoadBalancer

## Next increment

After this gateway path succeeds, add:

- DaemonSet log collection from `/var/log/pods`
- kubeletstats receiver for pod/node CPU and memory
- Kubernetes metadata enrichment
- deployment revision/image extraction
- automatic readiness, restart, OOM, and scheduling evidence

# SignalDeck Incident Lab

A deliberately small GKE-native application for safely generating real traces, deployment evidence, latency, HTTP failures, and dependency failures in a personal GCP project.

## Architecture

```text
client -> checkout -> inventory
              |           |
              +---- OTLP --+
                     |
            SignalDeck Collector
                     |
         hosted SignalDeck ingestion
```

## Failure modes

Send the `x-failure-mode` request header to the checkout service:

- `error`: checkout returns HTTP 500.
- `latency`: checkout waits 2.5 seconds.
- `dependency-error`: inventory returns HTTP 500.
- `dependency-latency`: inventory waits 3 seconds.
- `flaky`: intermittent checkout and inventory failures.

## Build images

Set values for your personal project:

```powershell
$ProjectId = "YOUR_GCP_PROJECT_ID"
$Region = "us-central1"
$Repo = "signaldeck-lab"

gcloud config set project $ProjectId
gcloud services enable artifactregistry.googleapis.com container.googleapis.com cloudbuild.googleapis.com

gcloud artifacts repositories create $Repo `
  --repository-format=docker `
  --location=$Region `
  --description="SignalDeck Incident Lab"

gcloud builds submit incident-lab `
  --config incident-lab/cloudbuild.yaml `
  --substitutions=_REGION=$Region,_REPOSITORY=$Repo
```

## Deploy

Replace `PROJECT_ID` and `REGION` in `k8s/incident-lab.yaml`, then:

```powershell
kubectl apply -f incident-lab/k8s/incident-lab.yaml
kubectl -n signaldeck-lab rollout status deployment/inventory
kubectl -n signaldeck-lab rollout status deployment/checkout
```

## Generate traffic

```powershell
kubectl -n signaldeck-lab port-forward service/checkout 8088:8080
```

In another PowerShell window:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8088/checkout"

Invoke-WebRequest -Method Post `
  -Uri "http://localhost:8088/checkout" `
  -Headers @{ "x-failure-mode" = "dependency-latency" }

Invoke-WebRequest -Method Post `
  -Uri "http://localhost:8088/checkout" `
  -Headers @{ "x-failure-mode" = "dependency-error" }
```

## Generate Kubernetes change evidence

```powershell
kubectl -n signaldeck-lab set env deployment/checkout FAILURE_MODE=flaky
kubectl -n signaldeck-lab rollout status deployment/checkout
```

Restore healthy behavior:

```powershell
kubectl -n signaldeck-lab set env deployment/checkout FAILURE_MODE=none
kubectl -n signaldeck-lab rollout status deployment/checkout
```

## Remove the lab

```powershell
kubectl delete namespace signaldeck-lab
```

The lab has no persistent database and stores no business data.

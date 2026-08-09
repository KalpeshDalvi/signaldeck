# SignalDeck Incident Lab

A deliberately small GKE-native application for generating real distributed traces, Kubernetes workload evidence, deployment changes, latency, HTTP failures, and dependency failures in a personal GCP project.

## Architecture

```text
traffic-generator
       |
       v
   checkout ----> inventory
       |              |
       +------ OTLP --+
              |
      SignalDeck Collector
        |          |
        |          +-- watches signaldeck-lab pods, deployments and events
        |
        v
https://signaldeck-mauve.vercel.app/api/otel
              |
              v
          SignalDeck
```

## Recommended deployment: one command

Requirements:

- Google Cloud CLI (`gcloud`)
- `kubectl`
- a personal GCP project with billing enabled
- the same SignalDeck ingestion key configured in Vercel

From the repository root:

```powershell
cd F:\signaldeck
git checkout main
git pull origin main

.\incident-lab\setup-gcp.ps1 `
  -ProjectId "YOUR_PERSONAL_GCP_PROJECT_ID" `
  -IngestionKey "YOUR_SIGNALDECK_INGESTION_KEY"
```

The script enables GKE, Artifact Registry, and Cloud Build; creates an Artifact Registry repository; builds both application images; creates a GKE Autopilot cluster named `signaldeck-lab`; deploys the OpenTelemetry collector; deploys checkout and inventory; and starts continuous traffic every two seconds.

Default region: `us-central1`.

## Validate the live lab

```powershell
kubectl -n signaldeck-lab get pods
kubectl -n signaldeck-system get pods
kubectl -n signaldeck-system logs deployment/signaldeck-collector --tail=100
```

Open:

- https://signaldeck-mauve.vercel.app/traces
- https://signaldeck-mauve.vercel.app/kubernetes
- https://signaldeck-mauve.vercel.app/incidents

Healthy traffic should continuously create real checkout -> inventory distributed traces.

## Controlled incident scenarios

Use the scenario runner:

```powershell
.\incident-lab\failure-scenarios.ps1 -Scenario latency
.\incident-lab\failure-scenarios.ps1 -Scenario error
.\incident-lab\failure-scenarios.ps1 -Scenario flaky
.\incident-lab\failure-scenarios.ps1 -Scenario restart
.\incident-lab\failure-scenarios.ps1 -Scenario scale-down
```

Return the lab to healthy state:

```powershell
.\incident-lab\failure-scenarios.ps1 -Scenario recover
```

### Expected evidence

`latency` should increase checkout trace duration and expose the slow dependency in the trace waterfall.

`error` should create failed checkout traces and an incident candidate.

`flaky` should create intermittent failed traces and changing error-rate evidence.

`restart` should produce Deployment/Pod/Event evidence without intentionally breaking the application for long.

`scale-down` removes inventory replicas, causing dependency failures and Kubernetes deployment evidence.

## Manual request testing

```powershell
kubectl -n signaldeck-lab port-forward service/checkout 8088:8080
```

Then:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:8088/checkout"
Invoke-WebRequest -Method Post -Uri "http://localhost:8088/checkout" -Headers @{ "x-failure-mode" = "latency" }
Invoke-WebRequest -Method Post -Uri "http://localhost:8088/checkout" -Headers @{ "x-failure-mode" = "error" }
```

## Remove application workloads

```powershell
kubectl delete namespace signaldeck-lab
kubectl delete namespace signaldeck-system
kubectl delete clusterrole signaldeck-lab-reader --ignore-not-found
kubectl delete clusterrolebinding signaldeck-lab-reader --ignore-not-found
```

## Delete the GKE cluster when finished

This is the important cost-control step:

```powershell
gcloud container clusters delete signaldeck-lab `
  --location=us-central1 `
  --project=YOUR_PERSONAL_GCP_PROJECT_ID
```

Optionally delete the Artifact Registry repository as well:

```powershell
gcloud artifacts repositories delete signaldeck-lab `
  --location=us-central1 `
  --project=YOUR_PERSONAL_GCP_PROJECT_ID
```

The lab contains no persistent business database and is intended only for controlled SignalDeck testing.

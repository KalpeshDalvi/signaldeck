param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$IngestionKey,
  [string]$Region = "us-central1",
  [string]$ClusterName = "signaldeck-lab",
  [string]$Repository = "signaldeck-lab"
)

$ErrorActionPreference = "Stop"

Write-Host "Configuring Google Cloud project $ProjectId" -ForegroundColor Cyan
gcloud config set project $ProjectId | Out-Host

gcloud services enable `
  container.googleapis.com `
  artifactregistry.googleapis.com `
  cloudbuild.googleapis.com `
  --project $ProjectId

$repoExists = gcloud artifacts repositories describe $Repository --location $Region --project $ProjectId 2>$null
if (-not $repoExists) {
  Write-Host "Creating Artifact Registry repository..." -ForegroundColor Cyan
  gcloud artifacts repositories create $Repository `
    --repository-format=docker `
    --location=$Region `
    --description="SignalDeck Incident Lab images" `
    --project=$ProjectId
}

Write-Host "Building checkout and inventory images with Cloud Build..." -ForegroundColor Cyan
gcloud builds submit incident-lab `
  --region=$Region `
  --config=incident-lab/cloudbuild.yaml `
  --substitutions="_REGION=$Region,_REPOSITORY=$Repository" `
  --project=$ProjectId

$clusterExists = gcloud container clusters describe $ClusterName --location=$Region --project=$ProjectId 2>$null
if (-not $clusterExists) {
  Write-Host "Creating GKE Autopilot cluster $ClusterName..." -ForegroundColor Cyan
  gcloud container clusters create-auto $ClusterName `
    --location=$Region `
    --project=$ProjectId
}

gcloud container clusters get-credentials $ClusterName `
  --location=$Region `
  --project=$ProjectId

Write-Host "Connected Kubernetes context:" -ForegroundColor Cyan
kubectl config current-context

kubectl create namespace signaldeck-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n signaldeck-system create secret generic signaldeck-ingestion `
  --from-literal="ingestion-key=$IngestionKey" `
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f incident-lab/k8s/collector.yaml

$tempManifest = Join-Path $env:TEMP "signaldeck-incident-lab.rendered.yaml"
(Get-Content incident-lab/k8s/incident-lab.yaml -Raw) `
  -replace "REGION", $Region `
  -replace "PROJECT_ID", $ProjectId | Set-Content $tempManifest

kubectl apply -f $tempManifest
kubectl apply -f incident-lab/k8s/traffic-generator.yaml

Write-Host "Waiting for workloads..." -ForegroundColor Cyan
kubectl -n signaldeck-system rollout status deployment/signaldeck-collector --timeout=5m
kubectl -n signaldeck-lab rollout status deployment/inventory --timeout=5m
kubectl -n signaldeck-lab rollout status deployment/checkout --timeout=5m
kubectl -n signaldeck-lab rollout status deployment/traffic-generator --timeout=5m

Write-Host "" 
Write-Host "SignalDeck Incident Lab is running." -ForegroundColor Green
kubectl -n signaldeck-lab get pods,svc
Write-Host "" 
Write-Host "Collector status:" -ForegroundColor Green
kubectl -n signaldeck-system get pods
Write-Host "" 
Write-Host "Live traffic is generated every 2 seconds. Open:" -ForegroundColor Green
Write-Host "https://signaldeck-mauve.vercel.app/traces"
Write-Host "https://signaldeck-mauve.vercel.app/kubernetes"
Write-Host "https://signaldeck-mauve.vercel.app/incidents"

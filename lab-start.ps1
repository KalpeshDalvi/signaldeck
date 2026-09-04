param(
  [string]$Project = "signaldeck-lab-kd",
  [string]$Cluster = "signaldeck-lab",
  [string]$Region = "us-central1",
  [string]$CloudSqlInstance = "",
  [string]$StateFile = ".signaldeck-lab-state.json"
)

$ErrorActionPreference = "Stop"

function Run-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & gcloud.cmd @Args
  if ($LASTEXITCODE -ne 0) { throw "gcloud.cmd failed: $($Args -join ' ')" }
}

if (-not (Test-Path $StateFile)) {
  throw "State file '$StateFile' was not found. Run .\lab-stop.ps1 first so the current lab sizes can be restored safely."
}

$state = Get-Content -Path $StateFile -Raw | ConvertFrom-Json
if ($state.project -ne $Project -or $state.cluster -ne $Cluster -or $state.region -ne $Region) {
  throw "State file does not match Project/Cluster/Region supplied to this script."
}

Write-Host "SignalDeck lab startup starting..."
Write-Host "Project: $Project | Cluster: $Cluster | Region: $Region"

if (-not $CloudSqlInstance -and $state.cloudSqlInstance) {
  $CloudSqlInstance = $state.cloudSqlInstance
}

if ($CloudSqlInstance) {
  Write-Host "Starting Cloud SQL instance '$CloudSqlInstance'..."
  Run-Gcloud sql instances patch $CloudSqlInstance --activation-policy=ALWAYS --project $Project --quiet
} else {
  Write-Host "Cloud SQL instance not specified; skipping Cloud SQL start."
}

foreach ($pool in $state.nodePools) {
  $numNodes = [int]$pool.numNodes
  if ($numNodes -lt 1) { $numNodes = 1 }
  Write-Host "Restoring node pool '$($pool.name)' to $numNodes node(s)..."
  Run-Gcloud container clusters resize $Cluster --node-pool $pool.name --num-nodes $numNodes --region $Region --project $Project --quiet
}

Run-Gcloud container clusters get-credentials $Cluster --region $Region --project $Project

Write-Host "Waiting for GKE nodes to become Ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=10m
if ($LASTEXITCODE -ne 0) { throw "GKE nodes did not become Ready within 10 minutes." }

Write-Host "Restoring SignalDeck deployment replica counts..."
foreach ($deployment in $state.deployments) {
  $replicas = [int]$deployment.replicas
  kubectl -n $deployment.namespace scale deployment/$($deployment.name) --replicas=$replicas
  if ($LASTEXITCODE -ne 0) { throw "Unable to restore deployment $($deployment.namespace)/$($deployment.name)." }
}

Write-Host "Waiting for deployments to roll out..."
foreach ($deployment in $state.deployments) {
  if ([int]$deployment.replicas -gt 0) {
    kubectl -n $deployment.namespace rollout status deployment/$($deployment.name) --timeout=5m
  }
}

Write-Host ""
Write-Host "SignalDeck lab is running."
Write-Host "Use .\lab-stop.ps1 when you are finished to stop worker compute and optional Cloud SQL compute again."

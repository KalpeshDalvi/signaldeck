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

Write-Host "SignalDeck lab shutdown starting..."
Write-Host "Project: $Project | Cluster: $Cluster | Region: $Region"

# Make sure kubectl is pointed at the intended cluster before touching workloads.
Run-Gcloud container clusters get-credentials $Cluster --region $Region --project $Project

# Stop telemetry first so no new data is generated while infrastructure is shutting down.
Write-Host "Stopping SignalDeck telemetry collector and demo traffic..."
kubectl -n signaldeck-system scale deployment/signaldeck-collector --replicas=0 2>$null
kubectl -n signaldeck-lab scale deployment --all --replicas=0 2>$null

# Capture the current node-pool sizes so lab-start.ps1 can restore them later.
$nodePoolsJson = & gcloud.cmd container node-pools list --cluster $Cluster --region $Region --project $Project --format=json
if ($LASTEXITCODE -ne 0) { throw "Unable to list GKE node pools." }
$nodePools = $nodePoolsJson | ConvertFrom-Json

$state = [ordered]@{
  project = $Project
  cluster = $Cluster
  region = $Region
  stoppedAt = (Get-Date).ToString("o")
  nodePools = @()
  cloudSqlInstance = $CloudSqlInstance
}

foreach ($pool in $nodePools) {
  $poolName = $pool.name
  $sizeText = & gcloud.cmd container clusters describe $Cluster --region $Region --project $Project --format="value(nodePools[?name='$poolName'].initialNodeCount)"
  if ($LASTEXITCODE -ne 0) { throw "Unable to read size for node pool $poolName." }
  $size = 1
  if ([int]::TryParse(($sizeText | Select-Object -First 1), [ref]$size) -eq $false) { $size = 1 }
  $state.nodePools += [ordered]@{ name = $poolName; numNodes = $size }
}

$state | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
Write-Host "Saved restore state to $StateFile"

# Scale every node pool to zero. This stops the worker VM compute charges.
foreach ($pool in $nodePools) {
  Write-Host "Scaling node pool '$($pool.name)' to 0..."
  Run-Gcloud container clusters resize $Cluster --node-pool $pool.name --num-nodes 0 --region $Region --project $Project --quiet
}

# Cloud SQL is optional until the migration is created. When supplied, stop its compute.
if ($CloudSqlInstance) {
  Write-Host "Stopping Cloud SQL instance '$CloudSqlInstance'..."
  Run-Gcloud sql instances patch $CloudSqlInstance --activation-policy=NEVER --project $Project --quiet
} else {
  Write-Host "Cloud SQL instance not specified; skipping Cloud SQL stop."
}

Write-Host ""
Write-Host "SignalDeck lab is shut down."
Write-Host "Remaining charges can still include GKE control-plane fees, persistent disks, Artifact Registry, Cloud SQL storage/backups, and other retained resources."

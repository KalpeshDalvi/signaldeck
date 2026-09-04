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

function Get-DeploymentState {
  param([string]$Namespace)
  $json = kubectl -n $Namespace get deployment -o json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $json) { return @() }
  $obj = $json | ConvertFrom-Json
  return @($obj.items | ForEach-Object {
    [ordered]@{
      namespace = $Namespace
      name = $_.metadata.name
      replicas = if ($null -eq $_.spec.replicas) { 1 } else { [int]$_.spec.replicas }
    }
  })
}

Write-Host "SignalDeck lab shutdown starting..."
Write-Host "Project: $Project | Cluster: $Cluster | Region: $Region"

Run-Gcloud container clusters get-credentials $Cluster --region $Region --project $Project

$nodePoolsJson = & gcloud.cmd container node-pools list --cluster $Cluster --region $Region --project $Project --format=json
if ($LASTEXITCODE -ne 0) { throw "Unable to list GKE node pools." }
$nodePools = $nodePoolsJson | ConvertFrom-Json

$state = [ordered]@{
  project = $Project
  cluster = $Cluster
  region = $Region
  stoppedAt = (Get-Date).ToString("o")
  nodePools = @()
  deployments = @()
  cloudSqlInstance = $CloudSqlInstance
}

foreach ($pool in $nodePools) {
  $poolName = $pool.name
  $sizeText = & gcloud.cmd container node-pools describe $poolName --cluster $Cluster --region $Region --project $Project --format="value(initialNodeCount)"
  if ($LASTEXITCODE -ne 0) { throw "Unable to read size for node pool $poolName." }
  $size = 1
  if ([int]::TryParse(($sizeText | Select-Object -First 1), [ref]$size) -eq $false) { $size = 1 }
  if ($size -lt 1) { $size = 1 }
  $state.nodePools += [ordered]@{ name = $poolName; numNodes = $size }
}

$state.deployments += Get-DeploymentState -Namespace "signaldeck-system"
$state.deployments += Get-DeploymentState -Namespace "signaldeck-lab"

$state | ConvertTo-Json -Depth 6 | Set-Content -Path $StateFile -Encoding UTF8
Write-Host "Saved restore state to $StateFile"

Write-Host "Stopping SignalDeck workloads and telemetry..."
foreach ($deployment in $state.deployments) {
  kubectl -n $deployment.namespace scale deployment/$($deployment.name) --replicas=0 2>$null
}

foreach ($pool in $nodePools) {
  Write-Host "Scaling node pool '$($pool.name)' to 0..."
  Run-Gcloud container clusters resize $Cluster --node-pool $pool.name --num-nodes 0 --region $Region --project $Project --quiet
}

if ($CloudSqlInstance) {
  Write-Host "Stopping Cloud SQL instance '$CloudSqlInstance'..."
  Run-Gcloud sql instances patch $CloudSqlInstance --activation-policy=NEVER --project $Project --quiet
} else {
  Write-Host "Cloud SQL instance not specified; skipping Cloud SQL stop."
}

Write-Host ""
Write-Host "SignalDeck lab is shut down."
Write-Host "Remaining charges can still include GKE control-plane fees, persistent disks, Artifact Registry, Cloud SQL storage/backups, and other retained resources."

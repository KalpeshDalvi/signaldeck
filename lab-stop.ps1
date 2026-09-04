param(
  [string]$Project = "signaldeck-lab-kd",
  [string]$Cluster = "signaldeck-lab",
  [string]$Region = "us-central1",
  [string]$CloudSqlInstance = "",
  [string]$StateFile = ".signaldeck-lab-state.json"
)

$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
  param(
    [Parameter(Mandatory = $true)][string[]]$CommandArgs,
    [switch]$Capture
  )

  # Windows PowerShell can surface normal gcloud stderr messages as
  # NativeCommandError when ErrorActionPreference is Stop. Temporarily
  # allow native stderr and use LASTEXITCODE as the source of truth.
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($Capture) {
      $output = & gcloud.cmd @CommandArgs 2>&1
      $exitCode = $LASTEXITCODE
      if ($exitCode -ne 0) {
        throw "gcloud.cmd failed ($exitCode): $($CommandArgs -join ' ')`n$($output -join [Environment]::NewLine)"
      }
      return $output
    }

    & gcloud.cmd @CommandArgs 2>&1 | ForEach-Object { Write-Host $_ }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "gcloud.cmd failed ($exitCode): $($CommandArgs -join ' ')"
    }
  }
  finally {
    $ErrorActionPreference = $oldPreference
  }
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

Invoke-Gcloud -CommandArgs @("container", "clusters", "get-credentials", $Cluster, "--region", $Region, "--project", $Project)

$nodePoolsJson = Invoke-Gcloud -Capture -CommandArgs @("container", "node-pools", "list", "--cluster", $Cluster, "--region", $Region, "--project", $Project, "--format=json")
$nodePools = ($nodePoolsJson -join [Environment]::NewLine) | ConvertFrom-Json

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
  $sizeText = Invoke-Gcloud -Capture -CommandArgs @("container", "node-pools", "describe", $poolName, "--cluster", $Cluster, "--region", $Region, "--project", $Project, "--format=value(initialNodeCount)")
  $size = 1
  $firstSize = (($sizeText | Select-Object -First 1).ToString()).Trim()
  if ([int]::TryParse($firstSize, [ref]$size) -eq $false) { $size = 1 }
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
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not scale deployment $($deployment.namespace)/$($deployment.name) to zero."
  }
}

foreach ($pool in $nodePools) {
  Write-Host "Scaling node pool '$($pool.name)' to 0..."
  Invoke-Gcloud -CommandArgs @("container", "clusters", "resize", $Cluster, "--node-pool", $pool.name, "--num-nodes", "0", "--region", $Region, "--project", $Project, "--quiet")
}

if ($CloudSqlInstance) {
  Write-Host "Stopping Cloud SQL instance '$CloudSqlInstance'..."
  Invoke-Gcloud -CommandArgs @("sql", "instances", "patch", $CloudSqlInstance, "--activation-policy=NEVER", "--project", $Project, "--quiet")
} else {
  Write-Host "Cloud SQL instance not specified; skipping Cloud SQL stop."
}

Write-Host ""
Write-Host "SignalDeck lab is shut down."
Write-Host "Remaining charges can still include GKE control-plane fees, persistent disks, Artifact Registry, Cloud SQL storage/backups, and other retained resources."

# Safe stop of SignalDeck-only GKE workloads; never resize/delete cluster nodes.
# Read-only unless -Apply is explicitly supplied. Supports GKE Autopilot.
param(
  [string]$Project = "signaldeck-lab-kd",
  [string]$Cluster = "signaldeck-lab",
  [string]$Region = "us-central1",
  [string]$CloudSqlInstance = "signaldeck-db",
  [string]$StateFile = ".signaldeck-lab-state.json",
  [switch]$Apply,
  [switch]$StopCloudSql
)
$ErrorActionPreference = "Stop"
if ($Project -ne "signaldeck-lab-kd" -or $Cluster -ne "signaldeck-lab" -or $Region -ne "us-central1") {
  throw "Refusing to operate on an unfamiliar project, cluster or region."
}
if ($StopCloudSql -and $CloudSqlInstance -ne "signaldeck-db") {
  throw "Refusing to stop a Cloud SQL instance other than the designated SignalDeck database."
}
function Invoke-Checked([string]$label,[scriptblock]$action) {
  Write-Host "--- $label"
  & $action
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
Invoke-Checked "Get SignalDeck cluster credentials" {
  gcloud.cmd container clusters get-credentials $Cluster --region=$Region --project=$Project
}
$namespaces = @("signaldeck-lab","signaldeck-system")
$deployments = @()
foreach ($ns in $namespaces) {
  $json = & kubectl.exe -n $ns get deployments -o json
  if ($LASTEXITCODE -ne 0) { throw "Could not read workloads in $ns; no scale changes made." }
  $obj = $json | ConvertFrom-Json
  foreach ($item in @($obj.items)) {
    $replicas = 1
    if ($null -ne $item.spec.replicas) { $replicas = [int]$item.spec.replicas }
    $deployments += [ordered]@{namespace=$ns;name=$item.metadata.name;replicas=$replicas}
  }
}
Write-Host "Discovered $($deployments.Count) SignalDeck deployments:"
$deployments | ForEach-Object { Write-Host "  $($_.namespace)/$($_.name) replicas=$($_.replicas)" }
if (-not $Apply) {
  Write-Host "DRY RUN: no resources changed."
  Write-Host "Use -Apply to pause SignalDeck workloads. -StopCloudSql additionally stops only signaldeck-db."
  Write-Host "Do not use -StopCloudSql until you verify Spacical and other services do not depend on it."
  return
}
if (Test-Path $StateFile) {
  throw "Restore state file already exists: $StateFile. Refusing to overwrite the original replica counts."
}
$state = [ordered]@{
  project=$Project;cluster=$Cluster;region=$Region;
  savedAt=(Get-Date).ToUniversalTime().ToString("o");
  deployments=$deployments;
  cloudSqlInstance=if($StopCloudSql){$CloudSqlInstance}else{""}
}
$state | ConvertTo-Json -Depth 8 | Set-Content -Path $StateFile -Encoding UTF8
Write-Host "Saved restore state to $StateFile."
foreach ($d in $deployments) {
  Invoke-Checked "Scale $($d.namespace)/$($d.name) to zero" {
    kubectl.exe -n $d.namespace scale "deployment/$($d.name)" --replicas=0
  }
}
if ($StopCloudSql) {
  Write-Host "Stopping Cloud SQL compute for $CloudSqlInstance (storage/backups remain billed)."
  Invoke-Checked "Pause signaldeck-db" {
    gcloud.cmd sql instances patch $CloudSqlInstance --activation-policy=NEVER --project=$Project --quiet
  }
}
Write-Host "SignalDeck deployments paused. GKE cluster not deleted/resized; Spacical services untouched."
Write-Host "Remaining costs can include regional GKE management, attached storage, retained disks, and SQL storage/backups."

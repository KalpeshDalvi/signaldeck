# Restore SignalDeck-only deployments previously paused with lab-stop.ps1.
# Never resize/delete the cluster or change other services in the shared project.
param(
  [string]$Project = "signaldeck-lab-kd",
  [string]$Cluster = "signaldeck-lab",
  [string]$Region = "us-central1",
  [string]$StateFile = ".signaldeck-lab-state.json",
  [switch]$Apply
)
$ErrorActionPreference = "Stop"
if ($Project -ne "signaldeck-lab-kd" -or $Cluster -ne "signaldeck-lab" -or $Region -ne "us-central1") {
  throw "Refusing to operate on an unfamiliar project, cluster or region."
}
if (-not (Test-Path $StateFile)) {
  throw "No saved restore state found at $StateFile. Do not invent original replica counts."
}
$state = Get-Content -Path $StateFile -Raw | ConvertFrom-Json
if ($state.project -ne $Project -or $state.cluster -ne $Cluster -or $state.region -ne $Region) {
  throw "Restore state does not match the selected GCP project, cluster or region."
}
function Invoke-Checked([string]$label,[scriptblock]$action) {
  Write-Host "--- $label"
  & $action
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}
Write-Host "Planned SignalDeck restore:"
foreach ($d in @($state.deployments)) {
  Write-Host "  $($d.namespace)/$($d.name) replicas=$($d.replicas)"
}
if ($state.cloudSqlInstance) { Write-Host "  Cloud SQL restart: $($state.cloudSqlInstance)" }
if (-not $Apply) {
  Write-Host "DRY RUN: no infrastructure changes made. Use -Apply to restore."
  return
}
if ($state.cloudSqlInstance -and $state.cloudSqlInstance -ne "signaldeck-db") {
  throw "Unexpected Cloud SQL instance in restore state."
}
if ($state.cloudSqlInstance) {
  Invoke-Checked "Restart signaldeck-db compute" {
    gcloud.cmd sql instances patch $state.cloudSqlInstance --activation-policy=ALWAYS --project=$Project --quiet
  }
}
Invoke-Checked "Refresh GKE credentials" {
  gcloud.cmd container clusters get-credentials $Cluster --region=$Region --project=$Project
}
foreach ($d in @($state.deployments)) {
  if ($d.namespace -notin @("signaldeck-lab","signaldeck-system") -or
      $d.name -notmatch "^[a-z0-9][a-z0-9.-]*$" -or
      [int]$d.replicas -lt 0 -or [int]$d.replicas -gt 20) {
    throw "Restore state includes an unexpected workload or replica count."
  }
  Invoke-Checked "Restore $($d.namespace)/$($d.name)" {
    kubectl.exe -n $d.namespace scale "deployment/$($d.name)" "--replicas=$($d.replicas)"
  }
}
foreach ($d in @($state.deployments)) {
  if ([int]$d.replicas -gt 0) {
    Invoke-Checked "Wait for rollout $($d.namespace)/$($d.name)" {
      kubectl.exe -n $d.namespace rollout status "deployment/$($d.name)" --timeout=5m
    }
  }
}
# Preserve a copy for audit/recovery and prevent accidental second restore.
Move-Item -Path $StateFile -Destination "$StateFile.restored" -Force
Write-Host "SignalDeck lab restored successfully; old state saved as $StateFile.restored."

<#
Safely reduce SignalDeck lab traffic without changing shared Google Cloud services.
By default this script is READ-ONLY. Use -Apply to scale only the traffic generator.
It never resizes/deletes the GKE cluster, stops Cloud SQL, or changes Spacical.
#>
param(
  [string]$Project = "signaldeck-lab-kd",
  [string]$Region = "us-central1",
  [string]$Cluster = "signaldeck-lab",
  [switch]$Apply
)
$ErrorActionPreference = "Stop"
$expectedProject = "signaldeck-lab-kd"
if ($Project -ne $expectedProject -or $Cluster -ne "signaldeck-lab") {
  throw "Refusing an unfamiliar project or cluster."
}
function Invoke-Checked([string]$label,[scriptblock]$call) {
  Write-Host "=== $label ==="
  & $call
  if ($LASTEXITCODE -ne 0) { throw "Command failed: $label" }
}
Invoke-Checked "GKE credentials" {
  gcloud.cmd container clusters get-credentials $Cluster --region=$Region --project=$Project
}
Invoke-Checked "Current lab workload" {
  kubectl.exe -n signaldeck-lab get deployment traffic-generator -o wide
}
if (-not $Apply) {
  Write-Host ""
  Write-Host "DRY RUN ONLY. No resources changed."
  Write-Host "To pause generator calls, run: .\scripts\pause-signaldeck-lab-safe.ps1 -Apply"
  Write-Host "GKE and Cloud SQL charges continue. This script deliberately does not stop shared resources."
  exit 0
}
Invoke-Checked "Pause lab traffic" {
  kubectl.exe -n signaldeck-lab scale deployment/traffic-generator --replicas=0
}
Invoke-Checked "Confirm lab traffic stopped" {
  kubectl.exe -n signaldeck-lab get deployment traffic-generator
}
Write-Host "Lab traffic paused. No Cloud SQL, Cloud Run, GKE cluster, or Spacical services were modified."
Write-Host "Note: Pausing traffic alone does not eliminate GKE and Cloud SQL charges."

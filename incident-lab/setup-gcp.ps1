param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$IngestionKey,
  [string]$Region = "us-central1",
  [string]$ClusterName = "signaldeck-lab",
  [string]$Repository = "signaldeck-lab"
)

$ErrorActionPreference = "Stop"

function Invoke-GCloud {
  param(
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [switch]$AllowFailure,
    [switch]$Quiet
  )

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & gcloud @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }

  if (-not $Quiet -and $output) {
    $output | ForEach-Object { Write-Host $_ }
  }

  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "gcloud command failed with exit code ${exitCode}: gcloud $($Arguments -join ' ')"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = @($output)
  }
}

function Invoke-Kubectl {
  param(
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [switch]$AllowFailure,
    [switch]$Quiet
  )

  # kubectl and GKE Autopilot legitimately emit warnings to stderr (for example,
  # resource-request mutation). Windows PowerShell can surface those as errors when
  # ErrorActionPreference is Stop, so judge success by the native exit code instead.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & kubectl @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }

  if (-not $Quiet -and $output) {
    $output | ForEach-Object { Write-Host $_ }
  }

  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "kubectl command failed with exit code ${exitCode}: kubectl $($Arguments -join ' ')"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = @($output)
  }
}

Write-Host "Configuring Google Cloud project $ProjectId" -ForegroundColor Cyan
Invoke-GCloud -Arguments @("config", "set", "project", $ProjectId) | Out-Null

Write-Host "Enabling required Google Cloud APIs..." -ForegroundColor Cyan
Invoke-GCloud -Arguments @(
  "services", "enable",
  "container.googleapis.com",
  "artifactregistry.googleapis.com",
  "cloudbuild.googleapis.com",
  "--project=$ProjectId"
) | Out-Null

$repoCheck = Invoke-GCloud -Arguments @(
  "artifacts", "repositories", "describe", $Repository,
  "--location=$Region",
  "--project=$ProjectId",
  "--format=value(name)"
) -AllowFailure -Quiet

if ($repoCheck.ExitCode -ne 0) {
  Write-Host "Creating Artifact Registry repository..." -ForegroundColor Cyan
  Invoke-GCloud -Arguments @(
    "artifacts", "repositories", "create", $Repository,
    "--repository-format=docker",
    "--location=$Region",
    "--description=SignalDeck Incident Lab images",
    "--project=$ProjectId"
  ) | Out-Null
}
else {
  Write-Host "Artifact Registry repository already exists." -ForegroundColor DarkGray
}

Write-Host "Building checkout and inventory images with Cloud Build..." -ForegroundColor Cyan
Invoke-GCloud -Arguments @(
  "builds", "submit", "incident-lab",
  "--region=$Region",
  "--config=incident-lab/cloudbuild.yaml",
  "--substitutions=_REGION=$Region,_REPOSITORY=$Repository",
  "--project=$ProjectId"
) | Out-Null

$clusterCheck = Invoke-GCloud -Arguments @(
  "container", "clusters", "describe", $ClusterName,
  "--location=$Region",
  "--project=$ProjectId",
  "--format=value(name)"
) -AllowFailure -Quiet

if ($clusterCheck.ExitCode -ne 0) {
  Write-Host "Creating GKE Autopilot cluster $ClusterName..." -ForegroundColor Cyan
  Invoke-GCloud -Arguments @(
    "container", "clusters", "create-auto", $ClusterName,
    "--location=$Region",
    "--project=$ProjectId"
  ) | Out-Null
}
else {
  Write-Host "GKE cluster already exists." -ForegroundColor DarkGray
}

Invoke-GCloud -Arguments @(
  "container", "clusters", "get-credentials", $ClusterName,
  "--location=$Region",
  "--project=$ProjectId"
) | Out-Null

Write-Host "Connected Kubernetes context:" -ForegroundColor Cyan
Invoke-Kubectl -Arguments @("config", "current-context") | Out-Null

# Namespace and secret are created idempotently. Keep the pipeline but prevent
# benign native stderr from becoming a terminating PowerShell error.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  kubectl create namespace signaldeck-system --dry-run=client -o yaml | kubectl apply -f -
  $pipelineExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousPreference
}
if ($pipelineExit -ne 0) { throw "Failed to create signaldeck-system namespace." }

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  kubectl -n signaldeck-system create secret generic signaldeck-ingestion `
    --from-literal="ingestion-key=$IngestionKey" `
    --dry-run=client -o yaml | kubectl apply -f -
  $pipelineExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $previousPreference
}
if ($pipelineExit -ne 0) { throw "Failed to create SignalDeck ingestion secret." }

Invoke-Kubectl -Arguments @("apply", "-f", "incident-lab/k8s/collector.yaml") | Out-Null

$tempManifest = Join-Path $env:TEMP "signaldeck-incident-lab.rendered.yaml"
(Get-Content incident-lab/k8s/incident-lab.yaml -Raw) `
  -replace "REGION", $Region `
  -replace "PROJECT_ID", $ProjectId | Set-Content $tempManifest

Invoke-Kubectl -Arguments @("apply", "-f", $tempManifest) | Out-Null
Invoke-Kubectl -Arguments @("apply", "-f", "incident-lab/k8s/traffic-generator.yaml") | Out-Null

Write-Host "Waiting for workloads..." -ForegroundColor Cyan
Invoke-Kubectl -Arguments @("-n", "signaldeck-system", "rollout", "status", "deployment/signaldeck-collector", "--timeout=5m") | Out-Null
Invoke-Kubectl -Arguments @("-n", "signaldeck-lab", "rollout", "status", "deployment/inventory", "--timeout=5m") | Out-Null
Invoke-Kubectl -Arguments @("-n", "signaldeck-lab", "rollout", "status", "deployment/checkout", "--timeout=5m") | Out-Null
Invoke-Kubectl -Arguments @("-n", "signaldeck-lab", "rollout", "status", "deployment/traffic-generator", "--timeout=5m") | Out-Null

Write-Host ""
Write-Host "SignalDeck Incident Lab is running." -ForegroundColor Green
Invoke-Kubectl -Arguments @("-n", "signaldeck-lab", "get", "pods,svc") | Out-Null
Write-Host ""
Write-Host "Collector status:" -ForegroundColor Green
Invoke-Kubectl -Arguments @("-n", "signaldeck-system", "get", "pods") | Out-Null
Write-Host ""
Write-Host "Live traffic is generated every 2 seconds. Open:" -ForegroundColor Green
Write-Host "https://signaldeck-mauve.vercel.app/traces"
Write-Host "https://signaldeck-mauve.vercel.app/kubernetes"
Write-Host "https://signaldeck-mauve.vercel.app/incidents"

param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("latency", "error", "flaky", "restart", "scale-down", "recover")]
  [string]$Scenario
)

$ErrorActionPreference = "Stop"
$namespace = "signaldeck-lab"

switch ($Scenario) {
  "latency" {
    kubectl -n $namespace set env deployment/checkout FAILURE_MODE=latency
    kubectl -n $namespace rollout status deployment/checkout --timeout=3m
    Write-Host "Latency incident enabled: checkout requests now add 2.5 seconds." -ForegroundColor Yellow
  }
  "error" {
    kubectl -n $namespace set env deployment/checkout FAILURE_MODE=error
    kubectl -n $namespace rollout status deployment/checkout --timeout=3m
    Write-Host "HTTP 500 incident enabled on checkout." -ForegroundColor Yellow
  }
  "flaky" {
    kubectl -n $namespace set env deployment/checkout FAILURE_MODE=flaky
    kubectl -n $namespace rollout status deployment/checkout --timeout=3m
    Write-Host "Intermittent failure incident enabled." -ForegroundColor Yellow
  }
  "restart" {
    kubectl -n $namespace rollout restart deployment/inventory
    kubectl -n $namespace rollout status deployment/inventory --timeout=3m
    Write-Host "Inventory rollout restart completed. Kubernetes rollout evidence should appear in SignalDeck." -ForegroundColor Yellow
  }
  "scale-down" {
    kubectl -n $namespace scale deployment/inventory --replicas=0
    Write-Host "Inventory scaled to zero. Checkout dependency failures should begin." -ForegroundColor Red
  }
  "recover" {
    kubectl -n $namespace set env deployment/checkout FAILURE_MODE=none
    kubectl -n $namespace scale deployment/inventory --replicas=2
    kubectl -n $namespace rollout status deployment/inventory --timeout=3m
    kubectl -n $namespace rollout status deployment/checkout --timeout=3m
    Write-Host "Incident Lab returned to healthy state." -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "Watch SignalDeck:" -ForegroundColor Cyan
Write-Host "https://signaldeck-mauve.vercel.app/incidents"
Write-Host "https://signaldeck-mauve.vercel.app/traces"
Write-Host "https://signaldeck-mauve.vercel.app/kubernetes"

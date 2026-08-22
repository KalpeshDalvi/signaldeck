param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("latency", "error", "flaky", "restart", "scale-down", "payments-error", "payments-latency", "payments-recover", "recover")]
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
  "payments-error" {
    kubectl -n $namespace set env deployment/payments FAILURE_MODE=dependency-error
    kubectl -n $namespace rollout status deployment/payments --timeout=3m
    Write-Host "Payments application-level HTTP 500 incident enabled. Pods remain healthy and no downstream dependency is involved." -ForegroundColor Red
  }
  "payments-latency" {
    kubectl -n $namespace set env deployment/payments FAILURE_MODE=dependency-latency
    kubectl -n $namespace rollout status deployment/payments --timeout=3m
    Write-Host "Payments application latency incident enabled. Pods remain healthy." -ForegroundColor Yellow
  }
  "payments-recover" {
    kubectl -n $namespace set env deployment/payments FAILURE_MODE=none
    kubectl -n $namespace rollout status deployment/payments --timeout=3m
    Write-Host "Payments returned to healthy state." -ForegroundColor Green
  }
  "recover" {
    kubectl -n $namespace set env deployment/checkout FAILURE_MODE=none
    kubectl -n $namespace set env deployment/payments FAILURE_MODE=none
    kubectl -n $namespace scale deployment/inventory --replicas=2
    kubectl -n $namespace rollout status deployment/inventory --timeout=3m
    kubectl -n $namespace rollout status deployment/checkout --timeout=3m
    kubectl -n $namespace rollout status deployment/payments --timeout=3m
    Write-Host "Incident Lab returned to healthy state." -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "Watch SignalDeck:" -ForegroundColor Cyan
Write-Host "https://signaldeck-mauve.vercel.app/incidents"
Write-Host "https://signaldeck-mauve.vercel.app/correlation"
Write-Host "https://signaldeck-mauve.vercel.app/traces"
Write-Host "https://signaldeck-mauve.vercel.app/kubernetes"

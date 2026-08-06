$ErrorActionPreference = "Stop"

$headers = @{ Authorization = "Bearer dev-signaldeck-key" }
$endpoint = "http://localhost:3000/api/telemetry"
$deploymentTime = (Get-Date).AddMinutes(-4).ToUniversalTime().ToString("o")
$failureTime = (Get-Date).AddMinutes(-2).ToUniversalTime().ToString("o")

$body = @{
  events = @(
    @{
      signal_type = "trace"
      workspace_id = "billpay"
      service_name = "checkout-api"
      environment = "production"
      message = "POST /checkout"
      duration_ms = 180
      status_code = 200
      severity = "INFO"
      observed_at = (Get-Date).AddMinutes(-8).ToUniversalTime().ToString("o")
      attributes = @{}
    },
    @{
      signal_type = "deployment"
      workspace_id = "billpay"
      service_name = "checkout-api"
      environment = "production"
      message = "checkout-api v2.4.1 deployed"
      severity = "INFO"
      observed_at = $deploymentTime
      attributes = @{
        "deployment.version" = "v2.4.1"
        "deployment.previous_version" = "v2.4.0"
        "container.image.name" = "us-east1-docker.pkg.dev/billpay/checkout-api:v2.4.1"
        "git.commit.sha" = "a41d92f0b7c34a83"
        "deployment.actor" = "jenkins"
      }
    },
    @{
      signal_type = "trace"
      workspace_id = "billpay"
      service_name = "checkout-api"
      environment = "production"
      message = "POST /checkout"
      duration_ms = 734
      status_code = 500
      severity = "ERROR"
      trace_id = "m3-failure-001"
      observed_at = $failureTime
      attributes = @{}
    },
    @{
      signal_type = "trace"
      workspace_id = "billpay"
      service_name = "checkout-api"
      environment = "production"
      message = "POST /checkout"
      duration_ms = 912
      status_code = 500
      severity = "ERROR"
      trace_id = "m3-failure-002"
      observed_at = (Get-Date).AddMinutes(-1).ToUniversalTime().ToString("o")
      attributes = @{}
    },
    @{
      signal_type = "log"
      workspace_id = "billpay"
      service_name = "checkout-api"
      environment = "production"
      message = "Payment authorization failed after deployment"
      severity = "ERROR"
      trace_id = "m3-failure-001"
      observed_at = $failureTime
      attributes = @{}
    }
  )
} | ConvertTo-Json -Depth 8

$result = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json" -Body $body
$result | ConvertTo-Json
Write-Host "Open http://localhost:3000/incidents and verify the What changed? evidence card."

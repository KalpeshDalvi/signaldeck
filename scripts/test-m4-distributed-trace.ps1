param(
  [string]$BaseUrl = "https://signaldeck-mauve.vercel.app",
  [string]$IngestionKey = "aug6-sigdeck"
)

$headers = @{
  Authorization = "Bearer $IngestionKey"
  "Content-Type" = "application/json"
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000
$traceId = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")).Substring(0,32)

function Attr([string]$key, [string]$value) {
  return @{ key = $key; value = @{ stringValue = $value } }
}

$payload = @{
  resourceSpans = @(
    @{
      resource = @{ attributes = @(
        (Attr "service.name" "checkout-api"),
        (Attr "deployment.environment" "dev"),
        (Attr "signaldeck.workspace.id" "billpay")
      ) }
      scopeSpans = @(@{
        scope = @{ name = "signaldeck.m4.fixture" }
        spans = @(
          @{
            traceId = $traceId
            spanId = "1111111111111111"
            name = "POST /checkout"
            kind = 2
            startTimeUnixNano = "$now"
            endTimeUnixNano = "$($now + 900000000)"
            attributes = @(
              (Attr "http.request.method" "POST"),
              @{ key = "http.response.status_code"; value = @{ intValue = "500" } }
            )
            status = @{ code = 2 }
          },
          @{
            traceId = $traceId
            spanId = "2222222222222222"
            parentSpanId = "1111111111111111"
            name = "GET inventory-service /inventory/42"
            kind = 3
            startTimeUnixNano = "$($now + 50000000)"
            endTimeUnixNano = "$($now + 350000000)"
            attributes = @(
              (Attr "http.request.method" "GET"),
              (Attr "server.address" "inventory-service"),
              @{ key = "http.response.status_code"; value = @{ intValue = "200" } }
            )
            status = @{ code = 1 }
          },
          @{
            traceId = $traceId
            spanId = "3333333333333333"
            parentSpanId = "1111111111111111"
            name = "SELECT inventory"
            kind = 3
            startTimeUnixNano = "$($now + 370000000)"
            endTimeUnixNano = "$($now + 820000000)"
            attributes = @(
              (Attr "db.system" "postgresql"),
              (Attr "db.operation.name" "SELECT"),
              (Attr "db.namespace" "inventory")
            )
            status = @{ code = 1 }
          }
        )
      })
    }
  )
} | ConvertTo-Json -Depth 20

$response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/otel/v1/traces" -Headers $headers -Body $payload
Write-Host "Sent distributed trace $traceId" -ForegroundColor Green
$response | Format-List
Write-Host "Open: $BaseUrl/traces?trace=$traceId"

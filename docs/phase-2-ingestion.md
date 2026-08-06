# Phase 2: telemetry ingestion

SignalDeck now accepts custom JSON events and OTLP/HTTP JSON for logs, traces, and metrics.

## Local development

Copy the environment file:

```powershell
copy .env.example .env.local
npm run dev
```

Without Supabase variables, telemetry is held in memory and resets when the Next.js process restarts.

## Test custom ingestion

```powershell
$headers = @{ Authorization = "Bearer dev-signaldeck-key" }
$body = @{
  events = @(
    @{
      signal_type = "trace"
      workspace_id = "billpay"
      service_name = "checkout-api"
      environment = "dev"
      message = "POST /checkout"
      duration_ms = 734
      status_code = 500
      severity = "ERROR"
      attributes = @{ "http.route" = "/checkout" }
    }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/api/telemetry `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

Read the stored records:

```text
GET http://localhost:3000/api/telemetry?limit=100
GET http://localhost:3000/api/telemetry?type=trace&limit=20
```

## Enable Supabase persistence

1. Open the Supabase SQL editor.
2. Run `supabase/schema.sql`.
3. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`.
4. Restart the development server.

The service-role key is server-only. Never prefix it with `NEXT_PUBLIC_` and never expose it to browser code.

## OpenTelemetry Collector

`otel/collector-config.yaml` receives application OTLP locally and forwards OTLP/HTTP JSON to SignalDeck.

Required collector environment variables:

```text
SIGNALDECK_ENDPOINT=https://your-signaldeck-host
SIGNALDECK_INGESTION_KEY=replace-me
SIGNALDECK_WORKSPACE_ID=billpay
SIGNALDECK_ENVIRONMENT=dev
K8S_NODE_NAME=<injected from spec.nodeName>
```

The next step is packaging this collector configuration as a Helm chart with GKE RBAC and a Kubernetes Secret for the ingestion key.

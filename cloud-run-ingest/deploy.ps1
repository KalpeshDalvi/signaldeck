param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$ServiceName = "signaldeck-ingest",
  [Parameter(Mandatory=$true)][string]$SupabaseUrl,
  [Parameter(Mandatory=$true)][string]$SupabaseServiceRoleKey,
  [Parameter(Mandatory=$true)][string]$IngestionKey
)

$ErrorActionPreference = "Stop"

gcloud config set project $ProjectId | Out-Null

gcloud run deploy $ServiceName `
  --source cloud-run-ingest `
  --region $Region `
  --project $ProjectId `
  --allow-unauthenticated `
  --min-instances 0 `
  --max-instances 3 `
  --cpu 1 `
  --memory 512Mi `
  --concurrency 80 `
  --timeout 30 `
  --set-env-vars "SUPABASE_URL=$SupabaseUrl,SUPABASE_SERVICE_ROLE_KEY=$SupabaseServiceRoleKey,SIGNALDECK_INGESTION_KEY=$IngestionKey"

$url = gcloud run services describe $ServiceName --region $Region --project $ProjectId --format="value(status.url)"
Write-Host ""
Write-Host "Cloud Run ingest is ready:" -ForegroundColor Green
Write-Host $url
Write-Host ""
Write-Host "Collector OTLP endpoint should be:" -ForegroundColor Cyan
Write-Host "$url"
Write-Host "The collector will append /v1/traces, /v1/logs and /v1/metrics automatically."

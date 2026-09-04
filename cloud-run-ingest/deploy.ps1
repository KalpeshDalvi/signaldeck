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
if (-not $url) { throw "Unable to resolve Cloud Run service URL." }

Write-Host ""
Write-Host "Cloud Run ingest is ready:" -ForegroundColor Green
Write-Host $url

Write-Host "Updating SignalDeck collector endpoint..." -ForegroundColor Cyan
kubectl apply -f incident-lab/k8s/collector.yaml | Out-Null
kubectl -n signaldeck-system set env deployment/signaldeck-collector SIGNALDECK_OTLP_ENDPOINT=$url | Out-Null
kubectl -n signaldeck-system rollout status deployment/signaldeck-collector --timeout=3m

Write-Host ""
Write-Host "Migration complete." -ForegroundColor Green
Write-Host "Collector now exports traces/logs/metrics directly to Cloud Run instead of Vercel."
Write-Host "OTLP base endpoint: $url"
Write-Host ""
Write-Host "Verify with:" -ForegroundColor Cyan
Write-Host "kubectl -n signaldeck-system logs deployment/signaldeck-collector --since=60s"
Write-Host "gcloud run services logs read $ServiceName --region $Region --project $ProjectId --limit 20"

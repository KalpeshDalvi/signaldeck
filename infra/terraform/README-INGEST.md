# Cloud Run ingestion connection — staged rollout

The Terraform identity module provisions a runtime service account, Cloud SQL
Client permission, and two Secret Manager secret **containers**. It does not
create password/key versions or change the existing Cloud Run service.

## Stage 1: Terraform

```powershell
cd F:\signaldeck\infra\terraform
git pull origin main
terraform init
terraform validate
terraform plan -var="project_id=signaldeck-lab-kd"
```

Expect a new service account, Cloud SQL IAM membership, two secret containers,
and two secret IAM memberships. Review the plan before applying.

## Stage 2: prerequisites (not yet automated)

1. Create a dedicated PostgreSQL login with only INSERT on telemetry_events,
   and only the minimum necessary schema privileges. The migration and
   workspace seed must be applied first.
2. Store the DATABASE_URL and SIGNALDECK_INGESTION_KEY values as new Secret
   Manager versions **outside Terraform**. Never paste secrets into chat,
   shell history, source files, or Terraform variables.
3. The app currently accepts DATABASE_URL. For Cloud Run Cloud SQL Unix sockets,
   the connection string must use a supported socket path, or adapt the app
   to PGHOST/PGDATABASE/PGUSER/PGPASSWORD before deployment.
4. Import the existing Cloud Run service before managing its configuration
   with Terraform. Do not apply a new Cloud Run resource blindly.
5. Build/test OTLP payload compatibility, tenancy isolation, retention,
   and readiness before enabling collector traffic.

Cloud SQL has ongoing charges. IAM and secret metadata typically have
little cost, but secret versions/access operations are metered.

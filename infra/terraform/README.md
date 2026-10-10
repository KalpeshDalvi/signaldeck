# SignalDeck Terraform

This first phase manages a **new** Cloud SQL PostgreSQL instance and its database only.
It does **not** manage the existing Cloud Run services or GKE cluster: import/reconcile
those resources before adding them to Terraform to avoid duplicates or downtime.

## One-time state bucket bootstrap (PowerShell)

Choose a globally unique bucket name. Use gcloud.cmd on this Windows machine:

```powershell
$Project = "signaldeck-lab-kd"
$Bucket = "REPLACE_WITH_GLOBALLY_UNIQUE_PRIVATE_BUCKET"
gcloud.cmd storage buckets create "gs://$Bucket" --project=$Project --location=us-central1 --uniform-bucket-level-access
gcloud.cmd storage buckets update "gs://$Bucket" --versioning
```

Enable bucket public access prevention and grant only the Terraform operator
access to its state. State may contain sensitive values. Do not publish it.

## Plan before provisioning

```powershell
cd F:\signaldeck\infra\terraform
terraform init -backend-config="bucket=$Bucket"
terraform fmt
terraform validate
terraform plan -var="project_id=signaldeck-lab-kd" -out=proposed.tfplan
terraform show proposed.tfplan
```

After reviewing the billable resources and Google Cloud pricing, apply explicitly:

```powershell
terraform apply proposed.tfplan
```

The default Enterprise shared-core db-f1-micro is **development/pilot only**.
Cloud SQL is billed while provisioned. The instance has deletion protection and
prevent_destroy; removing it requires an intentional reviewed change.

## Security / rollout blockers

- Existing ingestion code needs a database role, a Secret Manager connection
  secret, migrations, and a Cloud SQL attachment before deployment.
- No database password or API key belongs in Terraform variables or state.
  Provision runtime credentials out of band with least-privilege permissions.
- The first phase enables a public Cloud SQL IP with SSL required, but does
  not authorize external networks. Before production traffic, enforce Cloud SQL
  connector / IAM access and stronger certificate verification as appropriate.
- Cloud Run and GKE are deliberately not changed here.
- CI validates Terraform only; it does **not** apply changes automatically.
  Add workload identity federation and protected approvals before automated apply.

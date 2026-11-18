#!/usr/bin/env bash
# Run manually in Google Cloud Shell with an authorized GCP admin identity.
# Grants project-scoped Cloud Run and Cloud SQL VIEW roles to dedicated GitHub SA.
# Does not deploy, migrate, resize, pause, or delete infrastructure.
set -euo pipefail

project="signaldeck-lab-kd"
number="295916870482"
pool="signaldeck-github"
provider="github"
service_account="signaldeck-github-inventory@signaldeck-lab-kd.iam.gserviceaccount.com"
repo_id="1325713775"
owner_id="78541164"
claim_condition="assertion.repository_id == '1325713775' && assertion.repository_owner_id == '78541164' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'KalpeshDalvi/signaldeck/.github/workflows/gcp-inventory.yml@refs/heads/main'"

actual_project="$(gcloud config get-value project 2>/dev/null || true)"
if [[ "$actual_project" != "$project" ]]; then
  echo "Current gcloud project is '$actual_project'; set it to '$project' and re-run." >&2
  exit 1
fi
actual_number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
if [[ "$actual_number" != "$number" ]]; then
  echo "Unexpected project number; refusing IAM changes." >&2
  exit 1
fi

echo "Configuring dedicated GitHub Actions inventory trust in $project"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project="$project"

if ! gcloud iam workload-identity-pools describe "$pool" \
    --project="$project" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$pool" \
    --project="$project" --location=global \
    --display-name="SignalDeck GitHub Actions (restricted)"
fi

if ! gcloud iam workload-identity-pools providers describe "$provider" \
    --project="$project" --location=global --workload-identity-pool="$pool" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$provider" \
    --project="$project" --location=global --workload-identity-pool="$pool" \
    --display-name="Manual GitHub inventory on main only" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref" \
    --attribute-condition="$claim_condition"
else
  provider_condition="$(gcloud iam workload-identity-pools providers describe "$provider" \
    --project="$project" --location=global --workload-identity-pool="$pool" \
    --format='value(attributeCondition)')"
  if [[ "$provider_condition" != "$claim_condition" ]]; then
    echo "Existing provider has a different attribute condition; review it manually. No access grants made." >&2
    exit 1
  fi
fi

if ! gcloud iam service-accounts describe "$service_account" --project="$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create signaldeck-github-inventory --project="$project" \
    --display-name="SignalDeck GitHub inventory metadata reader"
fi

principal="principalSet://iam.googleapis.com/projects/295916870482/locations/global/workloadIdentityPools/signaldeck-github/attribute.repository_id/1325713775"
gcloud iam service-accounts add-iam-policy-binding "$service_account" \
  --project="$project" --role="roles/iam.workloadIdentityUser" \
  --member="$principal" --quiet >/dev/null

for role in roles/run.viewer roles/cloudsql.viewer; do
  gcloud projects add-iam-policy-binding "$project" \
    --member="serviceAccount:$service_account" --role="$role" --quiet >/dev/null
done

echo "SignalDeck inventory access configured"
echo "Service account: $service_account"
echo "Workflow: https://github.com/KalpeshDalvi/signaldeck/actions/workflows/gcp-inventory.yml"
echo "Run manually on main AFTER merging the companion workflow change."

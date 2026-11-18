#!/usr/bin/env bash
# Safe Cloud Run code-only rollout of Milestone 3 in the shared SignalDeck lab.
# No DB mutations, Cloud SQL shutdown, GKE changes, IAM grant changes, or secret edits.
# Default: dry-run/preflight. Pass --apply to deploy three EXISTING Cloud Run services.
set -Eeuo pipefail

PROJECT="signaldeck-lab-kd"
PROJECT_NUMBER="295916870482"
REGION="us-central1"
SQL_INSTANCE="signaldeck-db"
BACKUP_ID="1795043793223"
RELEASE_COMMIT="f23415da6ccfd71f5044b891e0953bef0e4f7854"
MODE="${1:---check}"

if [[ "$MODE" != "--check" && "$MODE" != "--apply" ]]; then
  echo "Usage: bash scripts/release-m3-cloudshell.sh [--check|--apply]" >&2
  exit 2
fi

for tool in gcloud git jq; do
  command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }
done
cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has uncommitted changes; refusing to deploy." >&2
  exit 1
fi
git merge-base --is-ancestor "$RELEASE_COMMIT" HEAD || {
  echo "Current checkout does not contain the validated Milestone 3 release." >&2
  exit 1
}
if [[ "$(gcloud config get-value project 2>/dev/null)" != "$PROJECT" ]]; then
  echo "Wrong active GCP project. Run: gcloud config set project $PROJECT" >&2
  exit 1
fi
if [[ "$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')" != "$PROJECT_NUMBER" ]]; then
  echo "Unexpected project number. Refusing GCP operations." >&2
  exit 1
fi
if [[ "$(gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT" --format='value(state)')" != "RUNNABLE" ]]; then
  echo "Cloud SQL $SQL_INSTANCE is not RUNNABLE; refusing deployment." >&2
  exit 1
fi
if [[ "$(gcloud sql backups describe "$BACKUP_ID" --instance="$SQL_INSTANCE" --project="$PROJECT" --format='value(status)')" != "SUCCESSFUL" ]]; then
  echo "The previously verified pre-migration backup is not SUCCESSFUL; refusing deployment." >&2
  exit 1
fi

declare -A SOURCES=(
  [signaldeck-read-api]="cloud-run-read-api"
  [signaldeck-ingest]="cloud-run-ingest"
  [signaldeck-dashboard]="."
)
SERVICES=(signaldeck-read-api signaldeck-ingest signaldeck-dashboard)
temp_dir="$(mktemp -d)"
chmod 700 "$temp_dir"
trap 'rm -rf "$temp_dir"' EXIT

for service in "${SERVICES[@]}"; do
  gcloud run services describe "$service" --project="$PROJECT" --region="$REGION" --format=json > "$temp_dir/$service-before.json"
  jq -e '.metadata.name != null and .status.latestReadyRevisionName != null and .spec.template.spec.serviceAccountName != null' "$temp_dir/$service-before.json" >/dev/null || {
    echo "Missing existing service/ready revision/service account for $service" >&2
    exit 1
  }
  old_revision="$(jq -r '.status.latestReadyRevisionName' "$temp_dir/$service-before.json")"
  echo "Verified $service: current ready revision $old_revision"
done

# Archive must remain disabled until runtime DB grants and the new APIs are verified.
if jq -e '.spec.template.spec.containers[]?.env[]? | select(.name == "SIGNALDECK_ARCHIVE_ENABLED" and .value == "true")' \
    "$temp_dir/signaldeck-ingest-before.json" >/dev/null; then
  echo "Archiving is already enabled on existing ingest. Review manually before releasing." >&2
  exit 1
fi

echo "Validated release ancestor: $RELEASE_COMMIT"
echo "Target project: $PROJECT / region: $REGION"
echo "Cloud SQL will remain running. GKE and Spacical will not be modified."
if [[ "$MODE" == "--check" ]]; then
  echo "DRY RUN OK. No resources changed."
  echo "After validating DB grants and reviewing release scope, run:"
  echo "  bash scripts/release-m3-cloudshell.sh --apply"
  exit 0
fi

for service in "${SERVICES[@]}"; do
  source_dir="${SOURCES[$service]}"
  echo "Deploying $service from source $source_dir (existing IAM and secrets preserved)"
  gcloud run deploy "$service" \
    --project="$PROJECT" --region="$REGION" \
    --source="$source_dir" --quiet
  gcloud run services describe "$service" --project="$PROJECT" --region="$REGION" --format=json > "$temp_dir/$service-after.json"

  old_sa="$(jq -r '.spec.template.spec.serviceAccountName' "$temp_dir/$service-before.json")"
  new_sa="$(jq -r '.spec.template.spec.serviceAccountName' "$temp_dir/$service-after.json")"
  if [[ "$old_sa" != "$new_sa" ]]; then
    echo "FAIL: $service runtime service account changed; stop and review." >&2
    exit 1
  fi
  old_env="$(jq -cS '[.spec.template.spec.containers[]?.env[]? | {name,value,valueFrom}] | sort_by(.name)' "$temp_dir/$service-before.json")"
  new_env="$(jq -cS '[.spec.template.spec.containers[]?.env[]? | {name,value,valueFrom}] | sort_by(.name)' "$temp_dir/$service-after.json")"
  if [[ "$old_env" != "$new_env" ]]; then
    echo "FAIL: $service environment/secret references changed; stop and review." >&2
    exit 1
  fi
  new_revision="$(jq -r '.status.latestReadyRevisionName // empty' "$temp_dir/$service-after.json")"
  if [[ -z "$new_revision" ]]; then
    echo "FAIL: $service has no ready revision." >&2
    exit 1
  fi
  echo "DEPLOYED $service: ready revision $new_revision"
done

echo "CODE ROLLOUT COMPLETE. Archive flag has NOT been enabled."
echo "Next: verify database grants, API/OTLP readiness and Saved Investigations UI."
echo "Only then set SIGNALDECK_ARCHIVE_ENABLED=true and perform a controlled lab test."

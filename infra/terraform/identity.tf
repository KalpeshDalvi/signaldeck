# Identity and secret containers only. Secret payloads must be added outside Terraform
# to keep credentials out of Terraform state.
resource "google_service_account" "ingest" {
  account_id   = "signaldeck-ingest-runtime"
  display_name = "SignalDeck Cloud Run ingestion runtime"
}

resource "google_project_iam_member" "ingest_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "signaldeck-database-url"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret" "ingestion_key" {
  secret_id = "signaldeck-ingestion-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "ingest_database_url" {
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest.email}"
}
resource "google_secret_manager_secret_iam_member" "ingest_ingestion_key" {
  secret_id = google_secret_manager_secret.ingestion_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest.email}"
}

output "ingest_runtime_service_account" {
  value = google_service_account.ingest.email
}

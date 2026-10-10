resource "google_sql_database_instance" "signaldeck" {
  name                = var.database_instance_name
  region              = var.region
  database_version    = var.database_version
  deletion_protection = var.enable_deletion_protection

  settings {
    tier              = var.database_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.database_disk_size_gb
    disk_autoresize   = false

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = false
    }
    ip_configuration {
      ipv4_enabled = true
      require_ssl  = true
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "signaldeck" {
  name     = var.database_name
  instance = google_sql_database_instance.signaldeck.name
}

output "instance_connection_name" {
  value = google_sql_database_instance.signaldeck.connection_name
}
output "database_name" {
  value = google_sql_database.signaldeck.name
}

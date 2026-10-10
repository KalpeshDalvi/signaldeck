variable "project_id" {
  type = string
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "database_instance_name" {
  type    = string
  default = "signaldeck-db"
}
variable "database_name" {
  type    = string
  default = "signaldeck"
}
variable "database_tier" {
  type    = string
  default = "db-f1-micro"
}
variable "database_version" {
  type    = string
  default = "POSTGRES_16"
}
variable "database_disk_size_gb" {
  type    = number
  default = 10
}
variable "enable_deletion_protection" {
  type    = bool
  default = true
}

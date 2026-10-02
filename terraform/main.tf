terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "image" {
  type        = string
  description = "Previously built container URI, preferably pinned to a digest."
}
variable "name_prefix" {
  type    = string
  default = "ingestion-lab"
}

resource "google_project_service" "api" {
  for_each = toset([
    "run.googleapis.com", "eventarc.googleapis.com", "pubsub.googleapis.com",
    "storage.googleapis.com", "bigquery.googleapis.com", "iam.googleapis.com"
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "archive" {
  name                        = "${var.project_id}-${var.name_prefix}-archive"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_storage_bucket" "control" {
  name                        = "${var.project_id}-${var.name_prefix}-control"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_bigquery_dataset" "lab" {
  dataset_id                 = "ingestion_lab"
  location                   = var.region
  delete_contents_on_destroy = false
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_bigquery_table" "observations" {
  dataset_id          = google_bigquery_dataset.lab.dataset_id
  table_id            = "observations"
  deletion_protection = true
  clustering          = ["source", "product_id"]
  time_partitioning {
    type  = "DAY"
    field = "observation_date"
  }
  require_partition_filter = true
  schema = jsonencode([
    for column in [
      ["product_id", "STRING"], ["identity_version", "STRING"], ["source", "STRING"],
      ["product_name", "STRING"], ["product_code", "STRING"], ["url", "STRING"],
      ["amount", "NUMERIC"], ["currency", "STRING"], ["observed_at", "TIMESTAMP"],
      ["observation_date", "DATE"], ["archive_name", "STRING"], ["archive_generation", "STRING"]
    ] : { name = column[0], type = column[1], mode = "NULLABLE" }
  ])
}

resource "google_service_account" "loader" {
  account_id   = "${var.name_prefix}-loader"
  display_name = "Archive reader and batch loader"
  depends_on   = [google_project_service.api]
}

resource "google_service_account" "trigger" {
  account_id   = "${var.name_prefix}-trigger"
  display_name = "Eventarc delivery only"
  depends_on   = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "archive_reader" {
  bucket = google_storage_bucket.archive.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.loader.email}"
}

resource "google_storage_bucket_iam_member" "control_writer" {
  bucket = google_storage_bucket.control.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.loader.email}"
}

resource "google_bigquery_dataset_iam_member" "loader" {
  dataset_id = google_bigquery_dataset.lab.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.loader.email}"
}

resource "google_project_iam_member" "job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.loader.email}"
}

resource "google_project_iam_member" "event_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.trigger.email}"
}

data "google_storage_project_service_account" "gcs" {
  project    = var.project_id
  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "storage_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_cloud_run_v2_service" "loader" {
  name                = "${var.name_prefix}-loader"
  location            = var.region
  deletion_protection = true
  template {
    service_account                  = google_service_account.loader.email
    timeout                          = "900s"
    max_instance_request_concurrency = 1
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = var.image
      resources {
        limits = { cpu = "1", memory = "256Mi" }
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "BQ_DATASET"
        value = google_bigquery_dataset.lab.dataset_id
      }
      env {
        name  = "BQ_LOCATION"
        value = var.region
      }
      env {
        name  = "ARCHIVE_BUCKET"
        value = google_storage_bucket.archive.name
      }
      env {
        name  = "CONTROL_BUCKET"
        value = google_storage_bucket.control.name
      }
      env {
        name  = "VENDORS_JSON"
        value = jsonencode({ "mercado-demo" = "retail" })
      }
    }
  }
  depends_on = [
    google_project_service.api, google_storage_bucket_iam_member.archive_reader,
    google_storage_bucket_iam_member.control_writer, google_bigquery_dataset_iam_member.loader,
    google_project_iam_member.job_user, google_bigquery_table.observations
  ]
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.loader.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.trigger.email}"
}

resource "google_eventarc_trigger" "archive" {
  name     = "${var.name_prefix}-archive"
  location = var.region
  matching_criteria {
    attribute = "type"
    value     = "google.cloud.storage.object.v1.finalized"
  }
  matching_criteria {
    attribute = "bucket"
    value     = google_storage_bucket.archive.name
  }
  destination {
    cloud_run_service {
      service = google_cloud_run_v2_service.loader.name
      region  = var.region
    }
  }
  service_account = google_service_account.trigger.email
  depends_on = [
    google_project_iam_member.storage_publisher, google_project_iam_member.event_receiver,
    google_cloud_run_v2_service_iam_member.invoker
  ]
}

output "archive_bucket" { value = google_storage_bucket.archive.name }
output "loader_uri" { value = google_cloud_run_v2_service.loader.uri }

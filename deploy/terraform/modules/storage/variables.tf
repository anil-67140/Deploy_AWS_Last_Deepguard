variable "bucket_name" {
  type = string
}

variable "bundle_source_dir" {
  description = "Folder with the Dockerfiles / compose file; zipped and uploaded so the VM can fetch it."
  type        = string
}

variable "backup_retention_days" {
  type    = number
  default = 30
}

variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "volume_gb" {
  type = number
}

variable "swap_mb" {
  type = number
}

variable "enable_https" {
  type = bool
}

variable "subnet_id" {
  type = string
}

variable "security_group_id" {
  type = string
}

variable "bucket_name" {
  type = string
}

variable "bucket_arn" {
  type = string
}

variable "bundle_key" {
  type = string
}

variable "sns_topic_arn" {
  type = string
}

variable "repo_url" {
  type = string
}

variable "repo_branch" {
  type = string
}

variable "compose_version" {
  type = string
}

variable "buildx_version" {
  type = string
}

variable "app_config" {
  description = "Non-secret settings written to .env"
  type        = map(string)
}

variable "secrets" {
  description = "Secret settings stored in SSM Parameter Store (SecureString). Empty values are skipped."
  type        = map(string)
  sensitive   = true
}

############################################
# General
############################################
variable "project_name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "deepguard"
}

variable "environment" {
  description = "Environment label (dev/demo/prod)."
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region. ap-south-1 (Mumbai) is the closest non-opt-in region to Pakistan and has every service used here."
  type        = string
  default     = "ap-south-1"
}

############################################
# Compute
############################################
variable "instance_type" {
  description = <<-EOT
    Free-Tier-eligible x86 instance type. Eligible types for accounts created on/after 15 Jul 2025:
    t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large (verify in your account with the
    `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true` command from the README).
    t3.small (2 GB RAM) is the default because PyTorch + MongoDB + Node + Chromium do not fit comfortably in 1 GB.
  EOT
  type        = string
  default     = "t3.small"

  validation {
    condition     = contains(["t3.micro", "t3.small", "c7i-flex.large", "m7i-flex.large"], var.instance_type)
    error_message = "Use one of: t3.micro, t3.small, c7i-flex.large, m7i-flex.large (x86 only; the Docker images are built for amd64)."
  }
}

variable "root_volume_gb" {
  description = "Root EBS gp3 size in GB (Free Tier covers up to 30 GB)."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_gb >= 16 && var.root_volume_gb <= 30
    error_message = "Use 16-30 GB: the Docker images need ~8 GB and Free Tier EBS tops out at 30 GB."
  }
}

variable "allowed_cidrs" {
  description = "Who may reach the website (ports 80/443). Use [\"YOUR.PUBLIC.IP/32\"] to keep the demo private."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "enable_https" {
  description = "true = automatic HTTPS via Let's Encrypt on <ip>.sslip.io (no domain needed). false = plain HTTP on the IP."
  type        = bool
  default     = false
}

variable "swap_mb" {
  description = "Swap file size. Protects the small VM from out-of-memory kills during Docker builds and big uploads."
  type        = number
  default     = 2048
}

############################################
# Application source
############################################
variable "repo_url" {
  description = "Public Git URL of the project (cloned on the VM)."
  type        = string
  default     = "https://github.com/anil-67140/Last_DeepGuard.git"
}

variable "repo_branch" {
  type    = string
  default = "main"
}

variable "compose_version" {
  description = "Docker Compose v2 plugin version (no leading v)."
  type        = string
  default     = "2.29.7"
}

variable "buildx_version" {
  description = "Docker Buildx plugin version (no leading v)."
  type        = string
  default     = "0.17.1"
}

############################################
# Secrets / external services (put them in terraform.tfvars, never in Git)
############################################
variable "supabase_url" {
  type = string
}

variable "supabase_anon_key" {
  description = "Public anon key (it is shipped to browsers by design, so it is not marked sensitive)."
  type        = string
}

variable "supabase_service_key" {
  description = "service_role key — server-side only."
  type        = string
  sensitive   = true
}

variable "groq_api_key" {
  description = "Optional. Enables the AI-written summary in PDF reports. Leave empty to skip."
  type        = string
  default     = ""
  sensitive   = true
}

############################################
# Notifications (SES + SNS + Budgets)
############################################
variable "alert_email" {
  description = "Your e-mail: receives CloudWatch/Budget alarms (SNS) and DeepGuard fraud alerts (SES)."
  type        = string
}

variable "enable_ses" {
  description = "Send DeepGuard fraud-alert e-mails through Amazon SES (SMTP). No app code change needed."
  type        = bool
  default     = true
}

variable "ses_sender_email" {
  description = "Verified From address. Empty = use alert_email."
  type        = string
  default     = ""
}

variable "ses_extra_recipients" {
  description = "More addresses to verify in SES. NEW SES ACCOUNTS ARE IN SANDBOX: they can only send to verified addresses, so add the e-mails of the users who will upload files."
  type        = list(string)
  default     = []
}

variable "alert_email_mode" {
  description = "all = mail after every finished job; critical_only = only when fraud was found."
  type        = string
  default     = "all"

  validation {
    condition     = contains(["all", "critical_only"], var.alert_email_mode)
    error_message = "alert_email_mode must be \"all\" or \"critical_only\"."
  }
}

variable "enable_budget" {
  description = "Create an AWS Budget that e-mails you before spending gets out of hand."
  type        = bool
  default     = true
}

variable "monthly_budget_usd" {
  description = "Budget limit (gross usage, credits NOT subtracted, so you see how fast credits are being used)."
  type        = number
  default     = 10
}

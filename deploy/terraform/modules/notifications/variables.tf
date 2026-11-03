variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "enable_ses" {
  type    = bool
  default = true
}

variable "ses_sender" {
  type = string
}

variable "ses_extra_emails" {
  type    = list(string)
  default = []
}

variable "enable_budget" {
  type    = bool
  default = true
}

variable "monthly_budget_usd" {
  type    = number
  default = 10
}

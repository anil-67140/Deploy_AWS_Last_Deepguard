output "sns_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "smtp_host" {
  value = var.enable_ses ? "email-smtp.${var.aws_region}.amazonaws.com" : ""
}

output "smtp_username" {
  value = var.enable_ses ? aws_iam_access_key.ses_smtp[0].id : ""
}

output "smtp_password" {
  description = "SES SMTP password (SigV4-derived from the IAM secret key; not the IAM secret itself)."
  value       = var.enable_ses ? aws_iam_access_key.ses_smtp[0].ses_smtp_password_v4 : ""
  sensitive   = true
}

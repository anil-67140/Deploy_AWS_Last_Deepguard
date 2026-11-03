############################################
# SNS — infrastructure alarms (CloudWatch, Budgets) -> your inbox
############################################
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email # AWS e-mails a confirmation link you must click once
}

############################################
# SES — DeepGuard fraud-alert e-mails
# The backend already speaks SMTP (nodemailer), and SES has an SMTP endpoint, so no code change is needed:
# we just hand it SES SMTP credentials derived from a locked-down IAM user.
############################################
locals {
  ses_identities = var.enable_ses ? toset(concat([var.ses_sender, var.alert_email], var.ses_extra_emails)) : toset([])
}

resource "aws_ses_email_identity" "this" {
  for_each = local.ses_identities
  email    = each.value # AWS sends a verification mail to each address
}

resource "aws_iam_user" "ses_smtp" {
  count         = var.enable_ses ? 1 : 0
  name          = "${var.name}-ses-smtp"
  force_destroy = true
}

resource "aws_iam_user_policy" "ses_send" {
  count = var.enable_ses ? 1 : 0
  name  = "send-only-from-verified-sender"
  user  = aws_iam_user.ses_smtp[0].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendRawEmail"] # the action SES SMTP uses
      Resource = "*"
      Condition = {
        StringEquals = { "ses:FromAddress" = var.ses_sender }
      }
    }]
  })
}

resource "aws_iam_access_key" "ses_smtp" {
  count = var.enable_ses ? 1 : 0
  user  = aws_iam_user.ses_smtp[0].name
}

############################################
# AWS Budgets — your safety net for the free tier
############################################
resource "aws_budgets_budget" "monthly" {
  count        = var.enable_budget ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Track gross usage: credits are NOT subtracted, so you see how quickly Free Tier credits are being consumed.
  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

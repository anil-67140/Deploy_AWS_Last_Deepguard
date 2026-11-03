output "site_url" {
  description = "Open this in the browser (first start takes ~10-20 min while Docker images build)."
  value       = module.compute.site_url
}

output "supabase_redirect_url" {
  description = "Add this as Site URL / Redirect URL in Supabase -> Authentication -> URL Configuration."
  value       = module.compute.site_url
}

output "instance_id" {
  value = module.compute.instance_id
}

output "public_ip" {
  value = module.compute.public_ip
}

output "connect_command" {
  description = "Shell on the VM without SSH keys or open port 22 (needs the Session Manager plugin, or use the EC2 console -> Connect -> Session Manager)."
  value       = "aws ssm start-session --region ${var.aws_region} --target ${module.compute.instance_id}"
}

output "bootstrap_log_command" {
  description = "Follow the first-boot progress."
  value       = "./scripts/remote.sh \"tail -n 40 /var/log/deepguard-bootstrap.log\""
}

output "backup_bucket" {
  value = module.storage.bucket_name
}

output "alerts_topic_arn" {
  value = module.notifications.sns_topic_arn
}

output "ses_sender" {
  value = var.enable_ses ? local.ses_sender : null
}

output "reminders" {
  value = <<-EOT
    1. Confirm the SNS subscription e-mail ("AWS Notification - Subscription Confirmation").
    2. Click the SES verification links sent to: ${join(", ", distinct(concat([local.ses_sender, var.alert_email], var.ses_extra_recipients)))}
    3. Run supabase/001_profiles.sql in the Supabase SQL editor and add the site_url above as a redirect URL.
    4. When you are done:  ./scripts/down.sh   (destroys everything, stops all charges)
  EOT
}

output "aws_region" {
  value = var.aws_region
}

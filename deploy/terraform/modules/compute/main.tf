data "aws_caller_identity" "current" {}

# Latest Amazon Linux 2023 (x86_64). Amazon-owned AMIs are Free-Tier eligible.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  burstable = startswith(var.instance_type, "t")

  # Stable address: allocated BEFORE the instance so the app URL is known when user-data is rendered.
  site_host    = var.enable_https ? "${replace(aws_eip.this.public_ip, ".", "-")}.sslip.io" : aws_eip.this.public_ip
  site_url     = "${var.enable_https ? "https" : "http"}://${local.site_host}"
  site_address = var.enable_https ? local.site_host : ":80"

  ssm_path = "/${var.name}"

  plain_env = merge(var.app_config, {
    SITE_URL     = local.site_url
    SITE_ADDRESS = local.site_address
    DATA_DIR     = "/opt/deepguard/data"
  })
}

############################################
# Secrets -> SSM Parameter Store (standard tier SecureString = free)
############################################
resource "random_password" "mongo" {
  length  = 32
  special = false # alphanumeric only: it ends up inside a mongodb:// URI
}

resource "random_password" "report_signing" {
  length  = 48
  special = false
}

locals {
  all_secrets = merge(var.secrets, {
    MONGO_ROOT_PASSWORD = random_password.mongo.result
    REPORT_SIGNING_KEY  = random_password.report_signing.result
  })
}

resource "aws_ssm_parameter" "secret" {
  # the key NAMES are not secret (only the values are), hence nonsensitive()
  for_each = toset(nonsensitive(keys(local.all_secrets)))

  name  = "${local.ssm_path}/${each.key}"
  type  = "SecureString"
  value = local.all_secrets[each.key]
}

############################################
# IAM role for the VM (no static keys on the box)
############################################
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vm" {
  name_prefix        = "${var.name}-vm-"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Session Manager: shell access without SSH keys or an open port 22
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.vm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "vm" {
  statement {
    sid     = "ReadOwnParameters"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path}/*",
    ]
  }

  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  statement {
    sid       = "ReadBundleAndBackups"
    actions   = ["s3:GetObject"]
    resources = ["${var.bucket_arn}/deploy/*", "${var.bucket_arn}/backups/*"]
  }

  statement {
    sid       = "WriteBackups"
    actions   = ["s3:PutObject"]
    resources = ["${var.bucket_arn}/backups/*"]
  }
}

resource "aws_iam_role_policy" "vm" {
  name   = "deepguard-vm"
  role   = aws_iam_role.vm.id
  policy = data.aws_iam_policy_document.vm.json
}

resource "aws_iam_instance_profile" "vm" {
  name_prefix = "${var.name}-vm-"
  role        = aws_iam_role.vm.name
}

############################################
# The VM
############################################
resource "aws_eip" "this" {
  domain = "vpc"

  tags = { Name = "${var.name}-eip" }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [var.security_group_id]
  iam_instance_profile        = aws_iam_instance_profile.vm.name
  associate_public_ip_address = true  # temporary address so first-boot has internet; replaced by the EIP
  monitoring                  = false # detailed monitoring is billable; basic 5-minute metrics are free

  user_data = templatefile("${path.root}/templates/user_data.sh.tftpl", {
    region          = var.aws_region
    bucket          = var.bucket_name
    ssm_path        = local.ssm_path
    repo_url        = var.repo_url
    repo_branch     = var.repo_branch
    bundle_key      = var.bundle_key # also makes the VM wait for the S3 upload
    eip             = aws_eip.this.public_ip
    swap_mb         = var.swap_mb
    compose_version = var.compose_version
    buildx_version  = var.buildx_version
    plain_env       = local.plain_env
  })
  user_data_replace_on_change = true

  # IMDSv2 only; hop limit 1 so containers cannot reach the instance credentials
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  # T3 defaults to "unlimited" CPU credits, which can bill extra CPU surcharges. "standard" can only throttle, never bill.
  dynamic "credit_specification" {
    for_each = local.burstable ? [1] : []

    content {
      cpu_credits = "standard"
    }
  }

  tags = { Name = "${var.name}-app" }

  # do not rebuild the VM just because AWS published a newer AMI
  lifecycle {
    ignore_changes = [ami]
  }

  depends_on = [
    aws_ssm_parameter.secret,
    aws_iam_role_policy.vm,
  ]
}

resource "aws_eip_association" "this" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.this.id
}

############################################
# CloudWatch alarms -> SNS -> e-mail (basic EC2 metrics are free; first 10 alarms are free)
############################################
resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${var.name}-status-check-failed"
  alarm_description   = "EC2 system/instance status check is failing."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [var.sns_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "cpu_credits_low" {
  count               = local.burstable ? 1 : 0
  alarm_name          = "${var.name}-cpu-credits-low"
  alarm_description   = "Burstable CPU credits nearly exhausted: the VM will be throttled (slow analyses)."
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 15
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [var.sns_topic_arn]
}

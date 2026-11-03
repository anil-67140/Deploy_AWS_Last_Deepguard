data "aws_caller_identity" "current" {}

locals {
  name = "${var.project_name}-${var.environment}"

  ses_sender = var.ses_sender_email != "" ? var.ses_sender_email : var.alert_email

  # Sizing profile: how much RAM each container may use and how big a batch the engine handles.
  # Measured on the real engine: ~580 MB at startup, ~740 MB peak for a 20,000-row batch.
  # Keys must match the instance types allowed in variables.tf.
  profiles = {
    # 1 GB: light demos only (relies on swap)
    "t3.micro" = {
      mongo_mem         = "400m"
      ai_mem            = "750m"
      backend_mem       = "350m"
      node_heap_mb      = 192
      context_rows      = 30000
      max_batch         = 10000
      batch_size        = 5000
      queue_concurrency = 1
    }
    # 2 GB: comfortable for demos and the project defence
    "t3.small" = {
      mongo_mem         = "450m"
      ai_mem            = "1000m"
      backend_mem       = "450m"
      node_heap_mb      = 320
      context_rows      = 100000
      max_batch         = 50000
      batch_size        = 20000
      queue_concurrency = 1
    }
    # 4 GB
    "c7i-flex.large" = {
      mongo_mem         = "1g"
      ai_mem            = "2g"
      backend_mem       = "1g"
      node_heap_mb      = 768
      context_rows      = 200000
      max_batch         = 100000
      batch_size        = 50000
      queue_concurrency = 2
    }
    # 8 GB
    "m7i-flex.large" = {
      mongo_mem         = "1500m"
      ai_mem            = "4g"
      backend_mem       = "1500m"
      node_heap_mb      = 1024
      context_rows      = 200000
      max_batch         = 100000
      batch_size        = 50000
      queue_concurrency = 2
    }
  }
  profile = local.profiles[var.instance_type]
}

module "network" {
  source = "./modules/network"

  name          = local.name
  instance_type = var.instance_type
  allowed_cidrs = var.allowed_cidrs
}

module "storage" {
  source = "./modules/storage"

  bucket_name       = "${local.name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  bundle_source_dir = "${path.root}/../docker"
}

module "notifications" {
  source = "./modules/notifications"

  name               = local.name
  aws_region         = var.aws_region
  alert_email        = var.alert_email
  enable_ses         = var.enable_ses
  ses_sender         = local.ses_sender
  ses_extra_emails   = var.ses_extra_recipients
  enable_budget      = var.enable_budget
  monthly_budget_usd = var.monthly_budget_usd
}

module "compute" {
  source = "./modules/compute"

  name          = local.name
  aws_region    = var.aws_region
  instance_type = var.instance_type
  volume_gb     = var.root_volume_gb
  swap_mb       = var.swap_mb
  enable_https  = var.enable_https

  subnet_id         = module.network.public_subnet_id
  security_group_id = module.network.app_security_group_id

  bucket_name = module.storage.bucket_name
  bucket_arn  = module.storage.bucket_arn
  bundle_key  = module.storage.bundle_key

  sns_topic_arn = module.notifications.sns_topic_arn

  repo_url        = var.repo_url
  repo_branch     = var.repo_branch
  compose_version = var.compose_version
  buildx_version  = var.buildx_version

  # non-secret settings -> written into .env by user-data
  app_config = {
    SUPABASE_URL      = var.supabase_url
    SUPABASE_ANON_KEY = var.supabase_anon_key
    ALERT_EMAIL_TO    = var.alert_email
    ALERT_EMAIL_MODE  = var.alert_email_mode
    GROQ_MODEL        = "llama-3.1-8b-instant"
    SMTP_HOST         = module.notifications.smtp_host
    SMTP_PORT         = "587"
    SMTP_FROM         = var.enable_ses ? "DeepGuard <${local.ses_sender}>" : ""
    SMTP_DRY_RUN      = var.enable_ses ? "false" : "true"
    MONGO_MEM         = local.profile.mongo_mem
    AI_MEM            = local.profile.ai_mem
    BACKEND_MEM       = local.profile.backend_mem
    NODE_HEAP_MB      = tostring(local.profile.node_heap_mb)
    CONTEXT_ROWS      = tostring(local.profile.context_rows)
    MAX_BATCH         = tostring(local.profile.max_batch)
    BATCH_SIZE        = tostring(local.profile.batch_size)
    QUEUE_CONCURRENCY = tostring(local.profile.queue_concurrency)
  }

  # secrets -> SSM Parameter Store (SecureString); the VM fetches them with its IAM role
  # Which keys exist is decided from known inputs only (values such as the SES password are unknown until apply).
  secrets = merge(
    { SUPABASE_SERVICE_KEY = var.supabase_service_key },
    var.groq_api_key != "" ? { GROQ_API_KEY = var.groq_api_key } : {},
    var.enable_ses ? {
      SMTP_USER = module.notifications.smtp_username
      SMTP_PASS = module.notifications.smtp_password
    } : {},
  )
}

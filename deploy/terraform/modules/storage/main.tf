# One private bucket:
#   deploy/   the zipped Docker files (so you can change them without pushing to Git)
#   backups/  DeepGuard database backups synced from the VM every 15 minutes
#
# force_destroy = true on purpose: `terraform destroy` must always work and leave nothing billable behind.
# To keep backups across a rebuild use  terraform apply -replace=module.compute.aws_instance.app  (the bucket survives).

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"

    filter {
      prefix = "backups/"
    }

    expiration {
      days = var.backup_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.bundle_source_dir
  output_path = "${path.module}/docker-bundle.zip"
  excludes    = [".env", "data/**"] # never upload local secrets or local volumes
}

resource "aws_s3_object" "bundle" {
  bucket = aws_s3_bucket.this.id
  key    = "deploy/docker-bundle.zip"
  source = data.archive_file.bundle.output_path
  etag   = data.archive_file.bundle.output_md5
}

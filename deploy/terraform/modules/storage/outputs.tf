output "bucket_name" {
  value = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}

# Referencing the object makes the VM wait until the bundle has been uploaded.
output "bundle_key" {
  value = aws_s3_object.bundle.key
}

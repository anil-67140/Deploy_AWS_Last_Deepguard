output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_eip.this.public_ip
}

output "site_url" {
  value = local.site_url
}

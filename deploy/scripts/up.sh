#!/usr/bin/env bash
# Build everything. First start needs ~10-20 min for the Docker images to build on the VM.
set -euo pipefail
cd "$(dirname "$0")/../terraform"
[ -f terraform.tfvars ] || { echo "Create terraform/terraform.tfvars first (copy terraform.tfvars.example)."; exit 1; }
terraform init -input=false
terraform apply
echo
echo "Follow the first boot:  ./scripts/remote.sh \"tail -n 40 /var/log/deepguard-bootstrap.log\""

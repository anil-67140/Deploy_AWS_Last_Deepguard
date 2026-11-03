#!/usr/bin/env bash
# Destroy EVERYTHING (VM, disk, Elastic IP, S3 bucket incl. backups, SES identities, alarms, budget).
# After this nothing is left that can consume Free Tier credits.
set -euo pipefail
cd "$(dirname "$0")/../terraform"
terraform destroy

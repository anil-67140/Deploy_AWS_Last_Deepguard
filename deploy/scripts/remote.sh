#!/usr/bin/env bash
# Run a shell command on the VM through AWS Systems Manager (no SSH keys, no open port 22) and print its output.
#   ./scripts/remote.sh "tail -n 40 /var/log/deepguard-bootstrap.log"
#   ./scripts/remote.sh "docker compose -f /opt/deepguard/app/deploy/docker/docker-compose.yml ps"
#   ./scripts/remote.sh deepguard-redeploy        # pull latest code + Docker files from S3/Git and rebuild
# Needs: aws CLI (configured), jq, terraform (state in ../terraform).
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 \"<command>\""; exit 1; }

cd "$(dirname "$0")/../terraform"
ID=$(terraform output -raw instance_id)
REGION=$(terraform output -raw aws_region)

CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$ID" \
  --document-name AWS-RunShellScript --timeout-seconds 3600 \
  --parameters "$(jq -n --arg c "$*" '{commands: [$c]}')" \
  --query Command.CommandId --output text)

while :; do
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$ID" \
    --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in
    Pending | InProgress | Delayed) sleep 5 ;;
    *) break ;;
  esac
done

aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$ID" \
  --query StandardOutputContent --output text
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$ID" \
  --query StandardErrorContent --output text >&2

[ "$STATUS" = "Success" ] || { echo "(command status: $STATUS)" >&2; exit 1; }

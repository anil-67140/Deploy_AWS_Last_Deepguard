# DeepGuard — AWS deployment (Terraform + Docker)

One small EC2 VM runs four containers; Terraform builds and destroys the whole thing with one command each.

```
Browser ──80/443──▶ web (Caddy: React build + reverse proxy)
                        ├─ /api, /socket.io ─▶ backend (Node.js) ─▶ ai-engine (FastAPI, PyTorch-CPU, XGBoost, GNN)
                        │                                      └──▶ mongo (private, password-protected)
                        └─ everything else ─▶ static React files
External: Supabase (login + roles)      Optional: Groq (AI report text)
```

## What AWS services are used (and why)

| Service | Purpose | Free-Tier note |
|---|---|---|
| **EC2** t3.small (Amazon Linux 2023) | runs the 4 containers | eligible type, see below |
| **EBS** gp3 20 GB | disk (Docker images ≈ 8 GB) | Free Tier covers up to 30 GB |
| **Elastic IP** | stable URL (the frontend bakes it in) | public IPv4 is billed hourly, covered by credits |
| **SES** | DeepGuard fraud-alert e-mails | the app's nodemailer talks to SES SMTP, **no code change** |
| **SNS** | CloudWatch + Budget alarms to your inbox | negligible |
| **CloudWatch alarms** | status-check failure, CPU-credit exhaustion | first 10 alarms free |
| **AWS Budgets** | e-mail at 50% / 80% / forecast 100% of your limit | first 2 budgets free |
| **S3** | Docker bundle + DeepGuard DB backups (synced every 15 min) | tiny |
| **SSM Parameter Store** | secrets (SecureString) | standard parameters are free |
| **SSM Session Manager** | shell access, **no SSH port, no key pair** | free |
| **IAM** | VM role (least privilege) + send-only SES user | free |

Deliberately **not** used (they are not free or not needed): NAT Gateway, ALB, RDS/DocumentDB, ElastiCache/Redis (the app falls back to its built-in queue), ECR, CloudFront, Route 53.

## Free Tier: read this first

AWS changed the Free Tier on **15 July 2025**. For accounts created on/after that date the old "750 hours of t2/t3.micro" model is replaced by **credits** (up to ~$200) and a list of eligible instance types: `t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large`. Credits are used for *everything* (EC2, EBS, IPv4 …). On the **Free plan** the account closes when credits run out or after 6 months instead of billing you; on the **Paid plan** usage beyond credits is billed. Check which you are on in *Billing → Free Tier*.

Confirm your account's eligible list before applying:

```bash
aws ec2 describe-instance-types --region ap-south-1 \
  --filters Name=free-tier-eligible,Values=true --query "InstanceTypes[*].InstanceType" --output text
```

**Why `t3.small` and not `t3.micro` (your request):** I ran the real AI engine with the real models: **≈ 580 MB RAM at startup and ≈ 740 MB while analysing a 20,000-row batch**. On top of that come MongoDB, Node and Chromium (PDF reports). That does not fit in t3.micro's 1 GB without heavy swapping. `t3.small` (2 GB) is on the eligible list, so it is the default. `instance_type = "t3.micro"` still works (smaller batches are configured automatically) but expect slowness and don't rely on it for a live demo.

Approximate running cost if you left `t3.small` on 24/7: roughly **$20/month gross** (instance + disk + IPv4; prices vary by region — check the AWS pricing pages). The intended workflow is "apply → demo → destroy", i.e. cents per session.

Built-in cost protections: `standard` CPU-credit mode (T3 default "unlimited" can bill extra), no NAT gateway, no detailed monitoring, a 2 GB swap file, Budget alerts, and `./scripts/down.sh` which removes everything.

## Layout

```
deploy/
├── docker/
│   ├── ai-engine.Dockerfile   python 3.12 + CPU PyTorch + the 17 MB of model files the engine really reads
│   ├── backend.Dockerfile     node 20 + system Chromium for Puppeteer PDFs
│   ├── frontend.Dockerfile    Vite build -> Caddy
│   ├── Caddyfile              HTTP, or automatic HTTPS when SITE_ADDRESS is a hostname
│   ├── docker-compose.yml     mongo + ai-engine + backend + web (only web publishes ports)
│   ├── dockerignore           ALLOW-LIST: only mandatory files enter the build context
│   └── env.example            for running the same stack locally
├── terraform/
│   ├── main.tf variables.tf outputs.tf versions.tf terraform.tfvars.example
│   ├── templates/user_data.sh.tftpl      first-boot script (swap, Docker, build, start, backup timer)
│   └── modules/ network/  storage/  notifications/  compute/
└── scripts/  up.sh  down.sh  remote.sh
```

Only mandatory files are deployed: of the repo's 121 MB, the AI image receives 17 MB of models (no notebooks, figures, CSV result tables, `xgboost_final_trainval.json`, `xgboost_reference.json`, the 15 MB `gnn_account_risk.csv`, …); the backend image gets `package*.json` + `src/`; the frontend is built and only static files ship.

## Deploy

Prerequisites: Terraform ≥ 1.6, AWS CLI configured (`aws configure`), `jq`, a Supabase project (see below).

```bash
# 1. put this folder in your repo (optional — Terraform uploads it to S3 itself, so Git is not required)
cp -r deploy/ <your-repo>/deploy/

# 2. configure
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars      # fill in e-mail + Supabase keys (file is git-ignored)

# 3. build
cd ..  &&  ./scripts/up.sh                         # = terraform init + apply
```

`apply` itself finishes in ~2 minutes; the VM then builds the images, which takes **~10–20 minutes** on a T3 in `standard` credit mode. Watch it:

```bash
./scripts/remote.sh "tail -n 40 /var/log/deepguard-bootstrap.log"
```

When the log ends with `bootstrap finished`, open the `site_url` printed by Terraform.

**After apply (one-time clicks):**
1. Confirm the SNS subscription e-mail.
2. Click the SES verification e-mails. **New SES accounts are in sandbox: they can only send to verified addresses.** Add the e-mails of users who upload files to `ses_extra_recipients`, or request production access in the SES console.
3. Supabase: run `supabase/001_profiles.sql` in the SQL editor, and add `site_url` under *Authentication → URL Configuration*.

**Daily use**

| Task | Command |
|---|---|
| Shell on the VM | `aws ssm start-session --target <instance_id>` (or EC2 console → Connect → Session Manager) |
| Container status | `./scripts/remote.sh "docker compose -f /opt/deepguard/app/deploy/docker/docker-compose.yml ps"` |
| Pull new code / Docker changes | `terraform apply` (re-uploads bundle) then `./scripts/remote.sh deepguard-redeploy` |
| Fresh VM, keep S3 backups | `terraform apply -replace=module.compute.aws_instance.app`, then restore from **Admin → Backups** |
| **Destroy everything** | `./scripts/down.sh` |

Note: changing e-mail/Supabase/instance settings changes the VM's user-data, which **replaces the VM** (data is lost unless a backup was synced to S3). `terraform destroy` also deletes the S3 bucket and its backups, by design, so that nothing keeps billing.

## Things I found in the project (they shaped the deployment)

1. **`xgboost==3.4.1` needs Python ≥ 3.12.** It does not install on 3.11 (the README says "3.10+"). The image uses `python:3.12-slim`.
2. **The engine silently falls back to DEMO mode (random scores) if PyTorch fails to import, while `/health` still says "healthy".** The image therefore checks the import at build time, and its healthcheck reports *unhealthy* when `demo_mode` is true, so the backend will not start on top of a broken engine.
3. **The backend is not proxy-aware.** Behind Caddy every visitor would share one IP in the rate limiter. The backend Dockerfile patches in `app.set("trust proxy", 1)` with `sed` (and fails the build if it didn't apply). Cleaner: add that line to `server.js` yourself and delete the `sed` step.
4. `package.json` starts Node with `--max-old-space-size=4096`, impossible on a 2 GB VM; the image starts Node directly with a heap sized per instance type.
5. Vite bakes `VITE_*` at build time and `UploadPage.jsx` falls back to `localhost:4000`; that is why the Elastic IP is allocated first and passed in as the Socket.IO URL.
6. Redis and Ollama are optional in the code and are not deployed. `OLLAMA_URL` is intentionally unset (it would otherwise be tried first for reports); set `groq_api_key` for AI report text.
7. Mongo gets a generated password and is reachable only inside the Docker network. Secrets live in SSM, not in user-data or Git. (Terraform state, which is local by default, contains the generated secrets: keep `terraform.tfstate` private.)

## What was and was not verified

Verified here: the real AI engine booted from exactly the allow-listed model files (all models + GNN loaded, not demo mode) and answered batch requests; Node `npm ci` + the `trust proxy` patch + syntax check; Puppeteer honours `PUPPETEER_EXECUTABLE_PATH`; the Vite production build with the build args; the Caddyfile (`caddy validate` for both modes, plus a live routing test); the rendered user-data script (`bash -n`), the SSM→`.env` conversion, Terraform formatting/syntax and a cross-check of every variable/module/output reference.

**Not** verified (no Docker daemon, AWS account or Terraform registry access in my sandbox): the Docker image builds themselves, `terraform validate/plan/apply` against the real AWS provider, and the SES/Budget resources. Expect to possibly fix a small typo or two on the first `terraform plan`; the first boot log (`/var/log/deepguard-bootstrap.log`) will say exactly where anything fails.

## Run the same stack locally (optional)

```bash
cp deploy/docker/dockerignore .dockerignore
cd deploy/docker && cp env.example .env     # fill in Supabase values
mkdir -p data/backups data/uploads data/reports && sudo chown -R 1000:1000 data   # backend runs as uid 1000
docker compose up -d --build                # http://localhost
```

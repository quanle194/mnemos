#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu VPS (22.04/24.04; Debian 12 also works) for Mnemos and deploy it:
#   packages -> Docker Engine + compose plugin (Docker's apt repo) -> ufw baseline (22/80/443) -> deploy user and
#   /opt/mnemos layout -> clone/pull the repository -> .env with generated internal secrets (no provider secrets are
#   invented) -> nightly backup timer -> scripts/deploy.sh.
# Idempotent: re-running upgrades packages/repo and redeploys, and never overwrites an existing .env.
set -Eeuo pipefail

SCRIPT_NAME=bootstrap-ubuntu.sh
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/common.sh
source "$SELF_DIR/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage: sudo scripts/bootstrap-ubuntu.sh [options]

Options:
  --repo URL            git repository to deploy (default: origin of the checkout containing this script)
  --branch REF          branch or tag to deploy (default: main)
  --dir DIR             install root (default: /opt/mnemos) - repo in DIR/app, backups in DIR/backups
  --user NAME           unprivileged deploy user owning DIR and running the stack (default: mnemos)
  --domain NAME         public domain => automatic HTTPS (DNS A/AAAA must point here). Omit for HTTP-only mode.
  --acme-email EMAIL    ACME account e-mail (domain mode, optional)
  --http-port PORT      host HTTP port for Caddy (default 80)
  --https-port PORT     host HTTPS port for Caddy (default 443)
  --ssh-port PORT       SSH port to keep open in ufw (default: 22)
  --project NAME        docker compose project name (default: mnemos)
  --skip-firewall       do not touch ufw
  --skip-docker-install fail instead of installing Docker when it is missing
  --skip-deploy         prepare the host but do not run scripts/deploy.sh
  --no-backup-timer     do not install the nightly systemd backup timer
  --deploy-args "ARGS"  extra arguments for scripts/deploy.sh (e.g. "--with-mcp")
  --dry-run             print every action instead of executing it (no root needed)
  -h, --help            show this help

Operator-supplied values (domain, ACME e-mail, LLM/embedding provider credentials) are never invented. Without them
the stack runs in HTTP-only mode with deterministic built-in providers; edit DIR/app/.env and re-run deploy.sh.
EOF
}

REPO=""
BRANCH=main
ROOT_DIR=/opt/mnemos
DEPLOY_USER=mnemos
DOMAIN=""
ACME_EMAIL=""
HTTP_PORT=""
HTTPS_PORT=""
SSH_PORT=22
PROJECT=mnemos
SKIP_FIREWALL=0
SKIP_DOCKER_INSTALL=0
SKIP_DEPLOY=0
BACKUP_TIMER=1
DEPLOY_ARGS=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO=${2:?}; shift 2 ;;
    --branch) BRANCH=${2:?}; shift 2 ;;
    --dir) ROOT_DIR=${2:?}; shift 2 ;;
    --user) DEPLOY_USER=${2:?}; shift 2 ;;
    --domain) DOMAIN=${2:?}; shift 2 ;;
    --acme-email) ACME_EMAIL=${2:?}; shift 2 ;;
    --http-port) HTTP_PORT=${2:?}; shift 2 ;;
    --https-port) HTTPS_PORT=${2:?}; shift 2 ;;
    --ssh-port) SSH_PORT=${2:?}; shift 2 ;;
    --project) PROJECT=${2:?}; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --no-backup-timer) BACKUP_TIMER=0; shift ;;
    --deploy-args) DEPLOY_ARGS=${2-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

APP_DIR="$ROOT_DIR/app"
BACKUP_DIR_PATH="$ROOT_DIR/backups"
ENV_PATH="$APP_DIR/.env"

# ------------------------------------------------------------------------------------------------ helpers
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'DRY-RUN: %s\n' "$*" >&2
  else
    "$@"
  fi
}
as_user() { run runuser -u "$DEPLOY_USER" -- "$@"; }
# write_root_file PATH MODE  (content on stdin)
write_root_file() {
  local path=$1 mode=$2 content
  content=$(cat)
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'DRY-RUN: write %s (mode %s):\n    | %s\n' "$path" "$mode" "${content//$'\n'/$'\n'    | }" >&2
  else
    printf '%s\n' "$content" >"$path.tmp.$$"
    chmod "$mode" "$path.tmp.$$"
    mv -f "$path.tmp.$$" "$path"
  fi
}
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid --user '$DEPLOY_USER'"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || die "invalid --ssh-port '$SSH_PORT'"
[[ "$ROOT_DIR" = /* ]] || die "--dir must be an absolute path"

if [[ -z "$REPO" ]]; then
  REPO=$(git -C "$SELF_DIR/.." remote get-url origin 2>/dev/null || true)
  [[ -n "$REPO" ]] || die "--repo is required (no git origin found next to this script)"
fi

if [[ $DRY_RUN -eq 0 && $EUID -ne 0 ]]; then
  die "run as root (sudo) - or use --dry-run to preview the actions"
fi
[[ $DRY_RUN -eq 1 ]] && warn "dry-run: no changes will be made"

# ------------------------------------------------------------------------------------------------ 1. OS
banner "1/8 operating system"
# shellcheck source=/dev/null
. /etc/os-release
OS_ID=${ID:-unknown}
OS_CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
case "$OS_ID" in
  ubuntu) ok "Ubuntu ${VERSION_ID:-?} ($OS_CODENAME)" ;;
  debian) warn "Debian ${VERSION_ID:-?} detected - supported, but the runbook targets Ubuntu" ;;
  *) die "unsupported OS '$OS_ID' (Ubuntu 22.04/24.04 or Debian 12 expected)" ;;
esac
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
cpus=$(nproc)
log "host resources: ${cpus} vCPU, ${mem_mb} MiB RAM"
[[ $mem_mb -ge 3500 ]] || warn "less than 4 GB RAM: lower the *_MEM_LIMIT values in .env (see docs/RUNBOOK.md sizing)"

# ------------------------------------------------------------------------------------------------ 2. packages
banner "2/8 base packages"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -q
pkgs=(ca-certificates curl git gnupg jq openssl netcat-openbsd)
[[ $SKIP_FIREWALL -eq 0 ]] && pkgs+=(ufw)
run apt-get install -y -q --no-install-recommends "${pkgs[@]}"

# ------------------------------------------------------------------------------------------------ 3. docker
banner "3/8 Docker Engine + compose plugin"
if have_cmd docker && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo '?') with $(docker compose version --short 2>/dev/null) already installed"
elif [[ $SKIP_DOCKER_INSTALL -eq 1 ]]; then
  die "Docker Engine + compose plugin missing and --skip-docker-install given"
else
  log "installing Docker from the official apt repository (download.docker.com)"
  for p in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg -s "$p" >/dev/null 2>&1; then run apt-get remove -y -q "$p"; fi
  done
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  write_root_file /etc/apt/sources.list.d/docker.list 0644 <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable
EOF
  run apt-get update -q
  run apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [[ ! -f /etc/docker/daemon.json ]]; then
  run install -m 0755 -d /etc/docker
  write_root_file /etc/docker/daemon.json 0644 <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
EOF
  DAEMON_CHANGED=1
else
  log "/etc/docker/daemon.json exists - left unchanged"
  DAEMON_CHANGED=0
fi
if [[ -d /run/systemd/system ]]; then
  run systemctl enable --now docker
  [[ $DAEMON_CHANGED -eq 1 ]] && run systemctl restart docker
else
  warn "systemd not running - make sure the Docker daemon is started and enabled at boot"
fi

# ------------------------------------------------------------------------------------------------ 4. firewall
banner "4/8 firewall (ufw)"
if [[ $SKIP_FIREWALL -eq 1 ]]; then
  warn "--skip-firewall: ufw left untouched (ensure only 22/80/443 are reachable from the internet)"
else
  run ufw default deny incoming
  run ufw default allow outgoing
  if [[ "$SSH_PORT" == 22 ]]; then run ufw allow OpenSSH; else run ufw allow "$SSH_PORT/tcp"; fi
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  run ufw allow 443/udp
  run ufw --force enable
  ok "ufw: deny incoming except SSH($SSH_PORT), 80/tcp, 443/tcp+udp"
  warn "Docker-published ports bypass ufw: only the caddy service publishes ports (never add others)"
fi

# ------------------------------------------------------------------------------------------------ 5. user + dirs
banner "5/8 deploy user and directories"
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  ok "user $DEPLOY_USER exists"
else
  run useradd --system --user-group --home-dir "$ROOT_DIR" --shell /bin/bash "$DEPLOY_USER"
fi
if id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  ok "$DEPLOY_USER is in the docker group"
else
  run usermod -aG docker "$DEPLOY_USER"
fi
run install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$ROOT_DIR"
run install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$BACKUP_DIR_PATH"

# ------------------------------------------------------------------------------------------------ 6. repository
banner "6/8 repository ($REPO @ $BRANCH)"
if [[ -d "$APP_DIR/.git" ]]; then
  as_user git -C "$APP_DIR" fetch --prune --tags origin
  as_user git -C "$APP_DIR" checkout "$BRANCH"
  if [[ $DRY_RUN -eq 1 ]] || runuser -u "$DEPLOY_USER" -- git -C "$APP_DIR" symbolic-ref -q HEAD >/dev/null; then
    as_user git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  fi
elif [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
  die "$APP_DIR exists and is not a git checkout - move it away first"
else
  as_user git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# ------------------------------------------------------------------------------------------------ 7. env file
banner "7/8 environment file"
if [[ -f "$ENV_PATH" ]]; then
  ok "$ENV_PATH exists - kept as is (never overwritten)"
else
  init_args=(--output "$ENV_PATH" --backup-dir "$BACKUP_DIR_PATH")
  [[ -n "$DOMAIN" ]] && init_args+=(--domain "$DOMAIN")
  [[ -n "$ACME_EMAIL" ]] && init_args+=(--acme-email "$ACME_EMAIL")
  [[ -n "$HTTP_PORT" ]] && init_args+=(--http-port "$HTTP_PORT")
  [[ -n "$HTTPS_PORT" ]] && init_args+=(--https-port "$HTTPS_PORT")
  as_user "$APP_DIR/scripts/init-env.sh" "${init_args[@]}"
fi

# ------------------------------------------------------------------------------------------------ 8. backups
banner "8/8 nightly backup timer"
if [[ $BACKUP_TIMER -eq 0 ]]; then
  warn "--no-backup-timer: schedule scripts/backup.sh --verify yourself (see docs/RUNBOOK.md)"
elif [[ ! -d /run/systemd/system ]]; then
  warn "systemd is not running here; use cron instead:"
  warn "  30 2 * * * cd $APP_DIR && MNEMOS_PROJECT=$PROJECT scripts/backup.sh --verify --env-file $ENV_PATH >>$BACKUP_DIR_PATH/backup.log 2>&1"
else
  unit_src="$APP_DIR/infra/systemd"
  [[ $DRY_RUN -eq 1 && ! -d "$unit_src" ]] && unit_src="$SELF_DIR/../infra/systemd"
  sed -e "s#/opt/mnemos/app#$APP_DIR#g" -e "s#^User=mnemos#User=$DEPLOY_USER#" -e "s#^Group=mnemos#Group=$DEPLOY_USER#" \
    -e "s#^Environment=MNEMOS_PROJECT=mnemos#Environment=MNEMOS_PROJECT=$PROJECT#" \
    "$unit_src/mnemos-backup.service" | write_root_file /etc/systemd/system/mnemos-backup.service 0644
  write_root_file /etc/systemd/system/mnemos-backup.timer 0644 <"$unit_src/mnemos-backup.timer"
  run systemctl daemon-reload
  run systemctl enable --now mnemos-backup.timer
fi

# ------------------------------------------------------------------------------------------------ deploy
if [[ $SKIP_DEPLOY -eq 1 ]]; then
  warn "--skip-deploy: host prepared; deploy with: sudo -u $DEPLOY_USER $APP_DIR/scripts/deploy.sh --env-file $ENV_PATH"
else
  banner "deploy"
  # shellcheck disable=SC2086  # DEPLOY_ARGS is a deliberately word-split option string
  as_user env MNEMOS_PROJECT="$PROJECT" "$APP_DIR/scripts/deploy.sh" --env-file "$ENV_PATH" $DEPLOY_ARGS
fi

banner "bootstrap complete"
cat >&2 <<EOF
Install root:   $ROOT_DIR   (repo: $APP_DIR, backups: $BACKUP_DIR_PATH, env: $ENV_PATH)
Deploy user:    $DEPLOY_USER (member of the docker group - treat it as root-equivalent)
Next steps (docs/RUNBOOK.md):
  1. Create the first organization/workspace/admin key (store the returned api_key safely):
       curl -fsS -X POST <public URL>/api/v1/admin/bootstrap -H "X-Bootstrap-Secret: <API_BOOTSTRAP_SECRET from .env>" \\
            -H 'Content-Type: application/json' -d '{"organization_name":"acme","workspace_name":"default"}'
  2. Configure real LLM/embedding providers in $ENV_PATH (operator-supplied credentials), then redeploy:
       sudo -u $DEPLOY_USER env MNEMOS_PROJECT=$PROJECT $APP_DIR/scripts/deploy.sh --env-file $ENV_PATH
  3. Set SITE_ADDRESS to your domain for automatic HTTPS if you started in HTTP-only mode (then redeploy).
EOF

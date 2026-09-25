#!/usr/bin/env bash
# Create the production .env from infra/env.production.example with freshly generated internal secrets.
# Operator-only values (domain, ACME e-mail, AI provider credentials) are never invented: they are left at their
# documented defaults (HTTP-only mode, deterministic `fake` providers) unless passed explicitly.
set -Eeuo pipefail

SCRIPT_NAME=init-env.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage: scripts/init-env.sh [options]

Generate a production env file with random internal secrets (openssl rand -hex 32).

Options:
  --output PATH        env file to create (default: <repo>/.env)
  --template PATH      template (default: infra/env.production.example)
  --domain NAME        public domain => SITE_ADDRESS=NAME (automatic HTTPS), https:// public URLs, ALLOWED_HOSTS=NAME
  --acme-email EMAIL   ACME account e-mail (domain mode)
  --public-url URL     public base URL for HTTP-only mode (default: http://localhost[:HTTP_PORT])
  --http-port PORT     host HTTP port published by Caddy (default 80)
  --https-port PORT    host HTTPS port published by Caddy (default 443)
  --backup-dir DIR     BACKUP_DIR value (default from template: ./backups)
  --force              overwrite an existing output file (a timestamped copy of the old file is kept)
  --dry-run            print the resulting file (secrets masked) without writing
  -h, --help           show this help

Existing files are never modified without --force, so re-running is safe.
EOF
}

OUTPUT="$MNEMOS_ROOT/.env"
TEMPLATE="$MNEMOS_ROOT/infra/env.production.example"
DOMAIN=""
ACME_EMAIL=""
PUBLIC_URL=""
HTTP_PORT=""
HTTPS_PORT=""
BACKUP_DIR_OPT=""
FORCE=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT=${2:?}; shift 2 ;;
    --template) TEMPLATE=${2:?}; shift 2 ;;
    --domain) DOMAIN=${2:?}; shift 2 ;;
    --acme-email) ACME_EMAIL=${2:?}; shift 2 ;;
    --public-url) PUBLIC_URL=${2:?}; shift 2 ;;
    --http-port) HTTP_PORT=${2:?}; shift 2 ;;
    --https-port) HTTPS_PORT=${2:?}; shift 2 ;;
    --backup-dir) BACKUP_DIR_OPT=${2:?}; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

require_cmd openssl awk grep
[[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"

if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  die "invalid --domain '$DOMAIN' (expected a bare host name such as mnemos.example.com)"
fi

if [[ -e "$OUTPUT" && $FORCE -eq 0 && $DRY_RUN -eq 0 ]]; then
  ok "$OUTPUT already exists - leaving it untouched (use --force to regenerate)"
  exit 0
fi

umask 077
work=$(mktemp)
trap 'rm -f "$work"' EXIT
cp "$TEMPLATE" "$work"

gen() { openssl rand -hex 32; }
for key in POSTGRES_PASSWORD REDIS_PASSWORD API_BOOTSTRAP_SECRET API_KEY_PEPPER; do
  env_set "$work" "$key" "$(gen)"
done

[[ -n "$HTTP_PORT" ]] && env_set "$work" HTTP_PORT "$HTTP_PORT"
[[ -n "$HTTPS_PORT" ]] && env_set "$work" HTTPS_PORT "$HTTPS_PORT"
[[ -n "$BACKUP_DIR_OPT" ]] && env_set "$work" BACKUP_DIR "$BACKUP_DIR_OPT"

if [[ -n "$DOMAIN" ]]; then
  env_set "$work" SITE_ADDRESS "$DOMAIN"
  env_set "$work" PUBLIC_WEB_URL "https://$DOMAIN"
  env_set "$work" PUBLIC_API_URL "https://$DOMAIN/api"
  env_set "$work" ALLOWED_HOSTS "$DOMAIN"
  [[ -n "$ACME_EMAIL" ]] && env_set "$work" ACME_EMAIL "$ACME_EMAIL"
else
  env_set "$work" SITE_ADDRESS ":80"
  if [[ -z "$PUBLIC_URL" ]]; then
    port=${HTTP_PORT:-80}
    port=${port##*:}
    if [[ "$port" == "80" ]]; then PUBLIC_URL="http://localhost"; else PUBLIC_URL="http://localhost:$port"; fi
  fi
  PUBLIC_URL=${PUBLIC_URL%/}
  env_set "$work" PUBLIC_WEB_URL "$PUBLIC_URL"
  env_set "$work" PUBLIC_API_URL "$PUBLIC_URL/api"
fi

if grep -q "CHANGE_ME_GENERATED" "$work"; then
  die "internal error: unreplaced CHANGE_ME_GENERATED placeholders remain"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  log "dry-run: would write $OUTPUT with:"
  sed -E 's/^((POSTGRES_PASSWORD|REDIS_PASSWORD|API_BOOTSTRAP_SECRET|API_KEY_PEPPER)=).*/\1<generated>/' "$work" \
    | grep -Ev '^[[:space:]]*(#|$)'
  exit 0
fi

if [[ -e "$OUTPUT" ]]; then
  backup="$OUTPUT.$(date -u +%Y%m%dT%H%M%SZ).bak"
  cp -p "$OUTPUT" "$backup"
  warn "existing $OUTPUT saved as $backup"
fi
mkdir -p "$(dirname "$OUTPUT")"
install -m 600 "$work" "$OUTPUT"
ok "wrote $OUTPUT (mode 600) with generated POSTGRES_PASSWORD, REDIS_PASSWORD, API_BOOTSTRAP_SECRET, API_KEY_PEPPER"
if [[ -z "$DOMAIN" ]]; then
  warn "HTTP-only mode (SITE_ADDRESS=:80). Set SITE_ADDRESS to a domain for automatic HTTPS (see docs/RUNBOOK.md)."
fi
if [[ "$(MNEMOS_ENV_FILE=$OUTPUT env_get LLM_PROVIDER fake)" == "fake" ]]; then
  warn "LLM_PROVIDER/EMBEDDING_PROVIDER=fake: deterministic built-in providers. Configure real provider"
  warn "credentials (operator-supplied) in $OUTPUT before relying on learning quality."
fi

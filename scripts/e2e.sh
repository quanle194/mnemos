#!/usr/bin/env bash
# Boot the production Compose stack locally (APP_ENV=production, deterministic fake providers), run the
# Playwright E2E scenarios 1-10 and the learning eval against it through the Caddy edge, then tear it down.
#
# Usage: scripts/e2e.sh [--keep] [--no-build] [--skip-eval] [--http-port PORT]
# Env:   MNEMOS_BUILD_CA_FILE (extra CA for image builds behind TLS-intercepting proxies)
#        E2E_PROJECT (compose project, default mnemos-e2e)
set -Eeuo pipefail
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; }
KEEP=0 BUILD=1 EVAL=1 HTTP_PORT="${E2E_HTTP_PORT:-18080}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --skip-eval) EVAL=0; shift ;;
    --http-port) HTTP_PORT=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

require_docker
require_cmd curl openssl npx uv
MNEMOS_PROJECT="${E2E_PROJECT:-mnemos-e2e}"
WORKDIR=$(mktemp -d -t mnemos-e2e.XXXXXX)
MNEMOS_ENV_FILE="$WORKDIR/e2e.env"
export MNEMOS_PROJECT MNEMOS_ENV_FILE

"$MNEMOS_ROOT/scripts/init-env.sh" --output "$MNEMOS_ENV_FILE" --http-port "$HTTP_PORT" \
  --https-port "$((HTTP_PORT + 363))" --backup-dir "$WORKDIR/backups" >/dev/null
env_set "$MNEMOS_ENV_FILE" MNEMOS_VERSION e2e
SECRET=$(env_get API_BOOTSTRAP_SECRET)
BASE="http://localhost:${HTTP_PORT}"

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    compose ps || true
    compose logs --tail=60 api worker migrate caddy || true
  fi
  if [[ $KEEP -eq 0 ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
  else
    log "stack kept: project=$MNEMOS_PROJECT env=$MNEMOS_ENV_FILE base=$BASE"
  fi
  exit "$code"
}
trap cleanup EXIT

banner "boot production stack ($MNEMOS_PROJECT) on $BASE"
[[ $BUILD -eq 1 ]] && compose build
compose up -d --wait --wait-timeout 300
for _ in $(seq 1 60); do curl -fsS "$BASE/api/health/ready" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$BASE/api/health/ready" >/dev/null || die "stack not ready"
ok "stack ready"

mapfile -t FILES < <(compose_files)
COMPOSE_CMD="docker compose -p $MNEMOS_PROJECT ${FILES[*]} --env-file $MNEMOS_ENV_FILE"
mkdir -p "$MNEMOS_ROOT/artifacts"

banner "Playwright E2E (scenarios 1-10 + dashboard)"
(
  cd "$MNEMOS_ROOT/e2e"
  E2E_BASE_URL="$BASE" API_BOOTSTRAP_SECRET="$SECRET" E2E_COMPOSE="$COMPOSE_CMD" \
    E2E_JSON_REPORT="$MNEMOS_ROOT/artifacts/e2e-results.json" npx playwright test
)
ok "E2E passed"

if [[ $EVAL -eq 1 ]]; then
  banner "learning eval (Run A -> learn -> Run B) against the production-mode stack"
  (cd "$MNEMOS_ROOT" && uv run mnemos-eval --url "$BASE/api" --secret "$SECRET" --output artifacts/eval-report.json)
  ok "eval passed"
fi

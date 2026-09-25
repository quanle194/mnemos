#!/usr/bin/env bash
# Boot the production Compose stack locally (fake providers), run Playwright E2E scenarios 1-10 and the
# learning eval against it, then tear it down. Usage: scripts/e2e.sh [--keep] [--no-build] [--skip-eval]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP=0 BUILD=1 EVAL=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) BUILD=0 ;;
    --skip-eval) EVAL=0 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PROJECT="${E2E_PROJECT:-mnemos-e2e}"
HTTP_PORT="${E2E_HTTP_PORT:-18080}"
ENV_FILE="$(mktemp -t mnemos-e2e-env.XXXXXX)"
SECRET="$(openssl rand -hex 24)"
cat >"$ENV_FILE" <<ENV
APP_ENV=production
LOG_LEVEL=INFO
SITE_ADDRESS=:80
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${E2E_HTTPS_PORT:-18443}
PUBLIC_WEB_URL=http://localhost:${HTTP_PORT}
PUBLIC_API_URL=http://localhost:${HTTP_PORT}/api
POSTGRES_PASSWORD=$(openssl rand -hex 16)
API_BOOTSTRAP_SECRET=${SECRET}
API_KEY_PEPPER=$(openssl rand -hex 24)
LLM_PROVIDER=fake
EMBEDDING_PROVIDER=fake
EMBEDDING_MODEL=fake-embedding
EMBEDDING_DIMENSIONS=384
MNEMOS_VERSION=e2e
ENV

COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.prod.yml --env-file "$ENV_FILE")
cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then "${COMPOSE[@]}" ps || true; "${COMPOSE[@]}" logs --tail=80 api worker migrate || true; fi
  if [[ $KEEP -eq 0 ]]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -f "$ENV_FILE"; fi
  exit $code
}
trap cleanup EXIT

echo "==> booting stack $PROJECT on :$HTTP_PORT"
if [[ $BUILD -eq 1 ]]; then "${COMPOSE[@]}" build; fi
"${COMPOSE[@]}" up -d --wait --wait-timeout 300

BASE="http://localhost:${HTTP_PORT}"
for _ in $(seq 1 60); do
  curl -fsS "$BASE/api/health/ready" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$BASE/api/health/ready" >/dev/null

mkdir -p artifacts
echo "==> Playwright E2E"
(
  cd e2e
  E2E_BASE_URL="$BASE" API_BOOTSTRAP_SECRET="$SECRET" \
  E2E_COMPOSE="docker compose -p $PROJECT -f $ROOT/infra/docker-compose.prod.yml --env-file $ENV_FILE" \
  E2E_JSON_REPORT="$ROOT/artifacts/e2e-results.json" npx playwright test
)

if [[ $EVAL -eq 1 ]]; then
  echo "==> learning eval"
  uv run mnemos-eval --url "$BASE/api" --secret "$SECRET" --output artifacts/eval-report.json
fi
echo "==> E2E OK"

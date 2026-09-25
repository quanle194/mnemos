#!/usr/bin/env bash
# Deploy (or re-deploy / upgrade) the Mnemos production stack on this host.
#
#   preflight -> build or pull images -> start postgres+redis -> pre-migration backup (existing DB)
#   -> migrate -> start app services (wait for healthchecks) -> HTTP readiness gate -> smoke test
#   -> record release (MNEMOS_VERSION in the env file + release history) -> rollback guidance
set -Eeuo pipefail

SCRIPT_NAME=deploy.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage: scripts/deploy.sh [options]

Options:
  --version TAG      image tag to deploy (default: git describe of the checkout; with --no-build: MNEMOS_VERSION
                     from the env file)
  --no-build         pull images (MNEMOS_IMAGE_PREFIX/api|web:TAG) from a registry instead of building locally
  --pull-base        when building, also pull newer base images (security patches)
  --skip-backup      skip the pre-migration backup (NOT recommended for existing databases)
  --skip-smoke       skip scripts/smoke-prod.sh after the deploy
  --with-mcp         also run the optional MCP server (compose profile "mcp"; set MCP_ROUTE=enabled to expose /mcp)
  --with-ollama      also run the optional Ollama service (compose profile "ollama")
  --base-url URL     public URL for the readiness gate and smoke test (default: from SITE_ADDRESS/HTTP_PORT)
  --timeout SEC      health wait timeout (default: 300)
  --env-file PATH    env file (default: <repo>/.env)
  --project NAME     compose project name (default: mnemos)
  -h, --help         show this help

Environment: MNEMOS_BUILD_CA_FILE (extra CA for builds behind TLS-intercepting proxies),
             MNEMOS_COMPOSE_OVERRIDES (extra compose files, colon-separated).
EOF
}

VERSION=""
NO_BUILD=0
PULL_BASE=0
SKIP_BACKUP=0
SKIP_SMOKE=0
TIMEOUT=300
PROFILES=()
BASE_URL_OPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION=${2:?}; shift 2 ;;
    --no-build) NO_BUILD=1; shift ;;
    --pull-base) PULL_BASE=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --with-mcp) PROFILES+=(mcp); shift ;;
    --with-ollama) PROFILES+=(ollama); shift ;;
    --base-url) BASE_URL_OPT=${2:?}; shift 2 ;;
    --timeout) TIMEOUT=${2:?}; shift 2 ;;
    --env-file) MNEMOS_ENV_FILE=${2:?}; shift 2 ;;
    --project) MNEMOS_PROJECT=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

PREVIOUS_VERSION=""
STAGE="preflight"
on_failure() {
  local rc=$?
  [[ $rc -eq 0 ]] && return
  err "deploy FAILED during stage: $STAGE"
  cat >&2 <<EOF

Rollback guidance
  * Inspect:            docker compose -p $MNEMOS_PROJECT -f infra/docker-compose.prod.yml --env-file $MNEMOS_ENV_FILE ps
                        docker compose -p $MNEMOS_PROJECT -f infra/docker-compose.prod.yml --env-file $MNEMOS_ENV_FILE logs --tail 200 api worker migrate
  * Previous release:   ${PREVIOUS_VERSION:-<none recorded>}
EOF
  if [[ -n "$PREVIOUS_VERSION" && "$PREVIOUS_VERSION" != "${VERSION:-}" ]]; then
    cat >&2 <<EOF
  * App rollback (schema-compatible changes only):
                        scripts/upgrade.sh --rollback --to $PREVIOUS_VERSION --env-file $MNEMOS_ENV_FILE --project $MNEMOS_PROJECT
EOF
  fi
  if [[ -n "${PRE_BACKUP:-}" ]]; then
    cat >&2 <<EOF
  * Data rollback (if a migration ran and must be undone):
                        scripts/restore.sh --target live --file $PRE_BACKUP --env-file $MNEMOS_ENV_FILE --project $MNEMOS_PROJECT
EOF
  fi
}
trap on_failure EXIT

# ------------------------------------------------------------------------------------------------ preflight
banner "preflight"
require_docker
require_env_file
require_cmd curl git
export MNEMOS_PROJECT

problems=()
warnings=()
val() { env_get "$1" "${2-}"; }
need() { [[ -n "$(val "$1")" ]] || problems+=("$1 is empty${2:+ ($2)}"); }
for k in SITE_ADDRESS POSTGRES_PASSWORD REDIS_PASSWORD API_BOOTSTRAP_SECRET API_KEY_PEPPER PUBLIC_WEB_URL PUBLIC_API_URL; do
  need "$k"
done
if grep -qE '^[A-Z_]+=.*(CHANGE_ME|change-me)' "$MNEMOS_ENV_FILE"; then
  problems+=("placeholder values remain: $(grep -oE '^[A-Z_]+=.*(CHANGE_ME|change-me)' "$MNEMOS_ENV_FILE" | cut -d= -f1 | tr '\n' ' ')")
fi
bootstrap_secret=$(val API_BOOTSTRAP_SECRET)
[[ ${#bootstrap_secret} -ge 24 ]] || problems+=("API_BOOTSTRAP_SECRET must be >= 24 characters")
unset bootstrap_secret
for k in POSTGRES_PASSWORD REDIS_PASSWORD; do
  [[ "$(val "$k")" =~ ^[A-Za-z0-9._~-]*$ ]] || problems+=("$k must be URL-safe ([A-Za-z0-9._~-]); generate with: openssl rand -hex 32")
done
[[ "$(val APP_ENV production)" == production ]] || warnings+=("APP_ENV=$(val APP_ENV) (expected production)")
dims=$(val EMBEDDING_DIMENSIONS 384)
[[ "$dims" =~ ^[0-9]+$ && $dims -ge 8 && $dims -le 4096 ]] || problems+=("EMBEDDING_DIMENSIONS must be an integer 8..4096")
for kind in LLM EMBEDDING; do
  provider=$(val "${kind}_PROVIDER" fake)
  case "$provider" in
    fake) warnings+=("${kind}_PROVIDER=fake: deterministic built-in provider (configure a real provider for production quality)") ;;
    openai)
      need "${kind}_BASE_URL" "required for ${kind}_PROVIDER=openai"
      need "${kind}_API_KEY" "operator-supplied credential for ${kind}_PROVIDER=openai"
      need "${kind}_MODEL" "required for ${kind}_PROVIDER=openai" ;;
    ollama)
      need "${kind}_MODEL" "required for ${kind}_PROVIDER=ollama"
      [[ -n "$(val "${kind}_BASE_URL")" ]] || warnings+=("${kind}_BASE_URL empty: set http://ollama:11434 when using --with-ollama") ;;
    *) problems+=("${kind}_PROVIDER must be fake|openai|ollama (got '$provider')") ;;
  esac
done
if [[ "$(val MCP_ROUTE disabled)" == enabled && " ${PROFILES[*]} " != *" mcp "* ]]; then
  warnings+=("MCP_ROUTE=enabled but --with-mcp not given: /mcp will return 502 until the mcp service runs")
fi
site=$(val SITE_ADDRESS)
if [[ "$site" != :* && "$site" != http://* ]]; then
  log "TLS: automatic HTTPS for '$site' (DNS must point here; ports 80/443 reachable for ACME)"
else
  warnings+=("HTTP-only mode (SITE_ADDRESS=$site): use only on a private network or behind a TLS-terminating tunnel")
fi
avail_kb=$(df -Pk "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" 2>/dev/null | awk 'NR==2 {print $4}')
[[ -n "$avail_kb" && "$avail_kb" -lt 5242880 ]] && warnings+=("less than 5 GiB free for Docker ($((avail_kb / 1024)) MiB)")

for w in "${warnings[@]}"; do warn "$w"; done
if [[ ${#problems[@]} -gt 0 ]]; then
  for p in "${problems[@]}"; do err "$p"; done
  die "env file $MNEMOS_ENV_FILE failed validation"
fi

PROFILE_ARGS=()
for p in "${PROFILES[@]}"; do PROFILE_ARGS+=(--profile "$p"); done

# Version / build metadata
if [[ -z "$VERSION" ]]; then
  if [[ $NO_BUILD -eq 1 ]]; then
    VERSION=$(val MNEMOS_VERSION latest)
  elif git -C "$MNEMOS_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    VERSION=$(git -C "$MNEMOS_ROOT" describe --tags --always --dirty 2>/dev/null)
  else
    VERSION="build-$(date -u +%Y%m%d%H%M%S)"
  fi
fi
[[ "$VERSION" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$VERSION'"
export MNEMOS_VERSION="$VERSION"
MNEMOS_VCS_REF=$(git -C "$MNEMOS_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
MNEMOS_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export MNEMOS_VCS_REF MNEMOS_BUILD_DATE

compose "${PROFILE_ARGS[@]}" config -q || die "docker compose configuration is invalid"

api_cid=$(service_container api || true)
if [[ -n "$api_cid" ]]; then
  PREVIOUS_VERSION=$(docker inspect -f '{{.Config.Image}}' "$api_cid" 2>/dev/null | sed 's/.*://')
fi
ok "preflight passed: project=$MNEMOS_PROJECT version=$VERSION (previous: ${PREVIOUS_VERSION:-none}) env=$MNEMOS_ENV_FILE"

# ------------------------------------------------------------------------------------------------ images
if [[ $NO_BUILD -eq 1 ]]; then
  STAGE="pull images"
  banner "pull images ($VERSION)"
  compose "${PROFILE_ARGS[@]}" pull
else
  STAGE="build images"
  banner "build images ($VERSION)"
  build_args=()
  [[ $PULL_BASE -eq 1 ]] && build_args+=(--pull)
  compose "${PROFILE_ARGS[@]}" build "${build_args[@]}" api web
  compose "${PROFILE_ARGS[@]}" pull --ignore-buildable --quiet postgres redis caddy \
    || warn "could not pull infrastructure images (will use local copies if present)"
fi

# ------------------------------------------------------------------------------------------------ data services
STAGE="start postgres/redis"
banner "data services"
compose up -d --wait --wait-timeout "$TIMEOUT" postgres redis
ok "postgres and redis healthy"

# ------------------------------------------------------------------------------------------------ backup
PRE_BACKUP=""
db_initialized=$(psql_live "SELECT to_regclass('public.alembic_version') IS NOT NULL" 2>/dev/null | tr -d '[:space:]' || true)
if [[ "$db_initialized" == t ]]; then
  if [[ $SKIP_BACKUP -eq 1 ]]; then
    warn "--skip-backup: migrating an existing database WITHOUT a fresh backup"
  else
    STAGE="pre-migration backup"
    banner "pre-migration backup"
    PRE_BACKUP=$("$MNEMOS_ROOT/scripts/backup.sh" --label "pre-deploy-$VERSION" --env-file "$MNEMOS_ENV_FILE" \
      --project "$MNEMOS_PROJECT" --no-offsite | tail -n 1)
    ok "pre-migration backup: $PRE_BACKUP"
  fi
else
  log "fresh database (no alembic_version table) - nothing to back up"
fi

# ------------------------------------------------------------------------------------------------ migrate
STAGE="migrate"
banner "migrate"
compose run --rm --no-deps migrate
ok "migrations applied: $(psql_live "SELECT string_agg(version_num, ',') FROM alembic_version" | tr -d '[:space:]')"

# ------------------------------------------------------------------------------------------------ app services
STAGE="start application services"
banner "start application services"
compose "${PROFILE_ARGS[@]}" up -d --remove-orphans --wait --wait-timeout "$TIMEOUT"
compose "${PROFILE_ARGS[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' >&2 || true

# ------------------------------------------------------------------------------------------------ readiness gate
STAGE="readiness gate"
BASE=${BASE_URL_OPT:-$(default_base_url)}
curl_opts=(-fsS --max-time 10)
log "waiting for $BASE/api/health/ready"
deadline=$((SECONDS + TIMEOUT))
until body=$(curl "${curl_opts[@]}" "$BASE/api/health/ready" 2>/dev/null); do
  (( SECONDS < deadline )) || die "API not ready through the edge at $BASE within ${TIMEOUT}s"
  sleep 3
done
ok "edge readiness: $(printf '%s' "$body" | cut -c1-200)"

# ------------------------------------------------------------------------------------------------ record release
env_set "$MNEMOS_ENV_FILE" MNEMOS_VERSION "$VERSION"
STATE=$(state_dir)
printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VERSION" "$MNEMOS_VCS_REF" "deploy" >>"$STATE/releases.log"
ok "release recorded: MNEMOS_VERSION=$VERSION ($STATE/releases.log)"

# ------------------------------------------------------------------------------------------------ smoke
if [[ $SKIP_SMOKE -eq 0 ]]; then
  STAGE="smoke test"
  banner "smoke test"
  "$MNEMOS_ROOT/scripts/smoke-prod.sh" --base-url "$BASE" --env-file "$MNEMOS_ENV_FILE" \
    --project "$MNEMOS_PROJECT" --key-file "$STATE/smoke-admin.key"
fi

STAGE="done"
banner "deployed $VERSION"
if [[ -n "$PRE_BACKUP" ]]; then
  data_rollback="scripts/restore.sh --target live --file $PRE_BACKUP --env-file $MNEMOS_ENV_FILE --project $MNEMOS_PROJECT"
else
  data_rollback="n/a (fresh database or --skip-backup: no pre-migration backup was taken)"
fi
cat >&2 <<EOF
Dashboard:  $BASE/
API:        $BASE/api   (health: $BASE/api/health/ready)
Release:    $VERSION  (previous: ${PREVIOUS_VERSION:-none})
Backup:     ${PRE_BACKUP:-none (fresh database or --skip-backup)}

Rollback (application only, when the schema change was additive / expand-phase):
  scripts/upgrade.sh --rollback${PREVIOUS_VERSION:+ --to $PREVIOUS_VERSION} --env-file $MNEMOS_ENV_FILE --project $MNEMOS_PROJECT
Rollback (data, restores the pre-migration backup):
  $data_rollback
First workspace/API key (once):
  curl -fsS -X POST $BASE/api/v1/admin/bootstrap -H "X-Bootstrap-Secret: \$API_BOOTSTRAP_SECRET" \\
       -H 'Content-Type: application/json' -d '{"organization_name":"acme","workspace_name":"default"}'
EOF

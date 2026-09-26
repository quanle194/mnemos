# shellcheck shell=bash
# Shared helpers for the Mnemos operations scripts. Source it, do not execute it.
#
# Environment knobs understood by every script:
#   MNEMOS_ENV_FILE       env file for compose interpolation + app containers   (default: <repo>/.env)
#   MNEMOS_PROJECT        docker compose project name                           (default: mnemos)
#   MNEMOS_COMPOSE_FILE   production compose file                               (default: <repo>/infra/docker-compose.prod.yml)
#   MNEMOS_COMPOSE_OVERRIDES  extra compose files, colon-separated (applied after the main file)
#   MNEMOS_BUILD_CA_FILE  CA bundle passed to image builds as a BuildKit secret (TLS-intercepting proxies)
#   MNEMOS_STATE_DIR      release history / smoke key state                     (default: <backup dir>/state)
#   NO_COLOR              disable coloured output

if [[ -n "${_MNEMOS_COMMON_SOURCED:-}" ]]; then
  return 0
fi
_MNEMOS_COMMON_SOURCED=1

MNEMOS_ROOT="${MNEMOS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MNEMOS_PROJECT="${MNEMOS_PROJECT:-mnemos}"
MNEMOS_COMPOSE_FILE="${MNEMOS_COMPOSE_FILE:-$MNEMOS_ROOT/infra/docker-compose.prod.yml}"
MNEMOS_ENV_FILE="${MNEMOS_ENV_FILE:-$MNEMOS_ROOT/.env}"
MNEMOS_DEFAULT_PG_IMAGE="pgvector/pgvector:0.8.0-pg16"
SCRIPT_NAME="${SCRIPT_NAME:-$(basename "${0}")}"

if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  _C_RED=$'\033[31m'; _C_YEL=$'\033[33m'; _C_GRN=$'\033[32m'; _C_BLD=$'\033[1m'; _C_RST=$'\033[0m'
else
  _C_RED=""; _C_YEL=""; _C_GRN=""; _C_BLD=""; _C_RST=""
fi

_ts() { date -u +%H:%M:%S; }
log() { printf '%s [%s] %s\n' "$(_ts)" "$SCRIPT_NAME" "$*" >&2; }
ok() { printf '%s [%s] %sOK%s %s\n' "$(_ts)" "$SCRIPT_NAME" "$_C_GRN" "$_C_RST" "$*" >&2; }
warn() { printf '%s [%s] %sWARN%s %s\n' "$(_ts)" "$SCRIPT_NAME" "$_C_YEL" "$_C_RST" "$*" >&2; }
err() { printf '%s [%s] %sERROR%s %s\n' "$(_ts)" "$SCRIPT_NAME" "$_C_RED" "$_C_RST" "$*" >&2; }
die() { err "$*"; exit 1; }
banner() { printf '\n%s==== %s ====%s\n' "$_C_BLD" "$*" "$_C_RST" >&2; }

# Print a helpful location when a command fails under `set -E`.
_on_err() {
  local rc=$? line=${BASH_LINENO[0]:-?}
  err "command failed (exit ${rc}) at ${BASH_SOURCE[1]:-?}:${line}: ${BASH_COMMAND}"
}
install_err_trap() { trap _on_err ERR; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

abspath() {
  local p=$1
  if [[ "$p" = /* ]]; then printf '%s\n' "$p"; else printf '%s\n' "$PWD/$p"; fi
}

# ---------------------------------------------------------------------------------------------- env file access
# env_get KEY [DEFAULT] - value of the last KEY=... line in the env file (quotes stripped, no interpolation).
env_get() {
  local key=$1 default=${2-} line val
  if [[ -f "$MNEMOS_ENV_FILE" ]]; then
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$MNEMOS_ENV_FILE" | tail -n 1 || true)
    if [[ -n "$line" ]]; then
      val=${line#*=}
      val=${val%$'\r'}
      if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then
        val=${BASH_REMATCH[1]}
      fi
      printf '%s\n' "$val"
      return 0
    fi
  fi
  printf '%s\n' "$default"
}

# env_set FILE KEY VALUE - replace (or append) KEY=VALUE without interpreting VALUE.
env_set() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp "${file}.XXXXXX")
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file"; then
    awk -v k="$key" -v v="$value" '
      BEGIN { done = 0 }
      {
        line = $0
        sub(/^[[:space:]]*export[[:space:]]+/, "", line)
        if (index(line, k "=") == 1) {
          if (!done) { print k "=" v; done = 1 }
          next
        }
        print $0
      }' "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# ---------------------------------------------------------------------------------------------- compose
compose_files() {
  local -a files=(-f "$MNEMOS_COMPOSE_FILE")
  local f
  if [[ -n "${MNEMOS_BUILD_CA_FILE:-}" ]]; then
    [[ -s "$MNEMOS_BUILD_CA_FILE" ]] || die "MNEMOS_BUILD_CA_FILE=$MNEMOS_BUILD_CA_FILE is not a readable file"
    files+=(-f "$MNEMOS_ROOT/infra/docker-compose.build-ca.yml")
  fi
  if [[ -n "${MNEMOS_COMPOSE_OVERRIDES:-}" ]]; then
    local IFS=:
    for f in $MNEMOS_COMPOSE_OVERRIDES; do
      [[ -n "$f" ]] && files+=(-f "$f")
    done
  fi
  printf '%s\n' "${files[@]}"
}

# compose ARGS... - docker compose bound to the project, compose file(s) and env file.
compose() {
  local -a files
  mapfile -t files < <(compose_files)
  # exported so compose can interpolate ${MNEMOS_ENV_FILE} (env_file of the app services)
  export MNEMOS_ENV_FILE
  docker compose -p "$MNEMOS_PROJECT" "${files[@]}" --env-file "$MNEMOS_ENV_FILE" "$@"
}

require_docker() {
  require_cmd docker
  docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? is $(id -un) in the docker group?)"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin is required (apt install docker-compose-plugin)"
}

require_env_file() {
  [[ -f "$MNEMOS_ENV_FILE" ]] || die "env file not found: $MNEMOS_ENV_FILE (create it with scripts/init-env.sh)"
  MNEMOS_ENV_FILE=$(abspath "$MNEMOS_ENV_FILE")
  export MNEMOS_ENV_FILE
}

# container ID of a running service ("" when not running)
service_container() {
  compose ps -q --status running "$1" 2>/dev/null | head -n 1
}

service_running() { [[ -n "$(service_container "$1")" ]]; }

pg_user() { env_get POSTGRES_USER mnemos; }
pg_db() { env_get POSTGRES_DB mnemos; }
pg_image() { env_get POSTGRES_IMAGE "$MNEMOS_DEFAULT_PG_IMAGE"; }
# deployed version: exported MNEMOS_VERSION, else the env file's MNEMOS_VERSION, else "latest"
current_version() { printf '%s\n' "${MNEMOS_VERSION:-$(env_get MNEMOS_VERSION latest)}"; }
# app_image VERSION - the Python (api/worker/migrate/mcp) image reference for VERSION
app_image() { printf '%s/api:%s\n' "$(env_get MNEMOS_IMAGE_PREFIX mnemos)" "$1"; }

# psql_live SQL - run SQL in the live postgres service; tuples-only, unaligned output.
psql_live() {
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -q -A -t -U "$(pg_user)" -d "$(pg_db)" -c "$1"
}

# backup directory (absolute); relative BACKUP_DIR values are relative to the repository root.
backup_dir() {
  local d=${BACKUP_DIR:-$(env_get BACKUP_DIR ./backups)}
  [[ -n "$d" ]] || d=./backups
  if [[ "$d" != /* ]]; then d="$MNEMOS_ROOT/${d#./}"; fi
  printf '%s\n' "$d"
}

state_dir() {
  local d=${MNEMOS_STATE_DIR:-"$(backup_dir)/state"}
  mkdir -p "$d"
  chmod 700 "$d" 2>/dev/null || true
  printf '%s\n' "$d"
}

# Public base URL derived from SITE_ADDRESS/HTTP_PORT (override with BASE_URL).
default_base_url() {
  local site port
  site=$(env_get SITE_ADDRESS ":80")
  if [[ -n "${BASE_URL:-}" ]]; then
    printf '%s\n' "$BASE_URL"
  elif [[ "$site" == :* || "$site" == http://:* || -z "$site" ]]; then
    port=$(env_get HTTP_PORT 80)
    port=${port##*:}
    if [[ "$port" == "80" ]]; then printf 'http://localhost\n'; else printf 'http://localhost:%s\n' "$port"; fi
  elif [[ "$site" == http://* || "$site" == https://* ]]; then
    printf '%s\n' "${site%/}"
  else
    printf 'https://%s\n' "${site%%[ ,]*}"
  fi
}

# JSON field extraction: json_get '<jq filter>' <<<"$json". Uses jq, or a python3 fallback supporting
# dotted paths with [N] and [] (iteration), e.g. '.checks.database.ok', '.memories[].id'.
json_get() {
  local filter=$1
  if have_cmd jq; then
    jq -r "$filter // empty"
  else
    python3 -c '
import json, re, sys
path = sys.argv[1]
data = json.load(sys.stdin)
tokens = re.findall(r"\.([A-Za-z0-9_\-]+)|\[(\d*)\]", path)
cur = [data]
for name, idx in tokens:
    nxt = []
    for c in cur:
        if name:
            if isinstance(c, dict) and name in c:
                nxt.append(c[name])
        elif idx == "":
            if isinstance(c, list):
                nxt.extend(c)
        else:
            if isinstance(c, list) and int(idx) < len(c):
                nxt.append(c[int(idx)])
    cur = nxt
for c in cur:
    if c is None:
        continue
    if isinstance(c, bool):
        print("true" if c else "false")
    elif isinstance(c, (dict, list)):
        print(json.dumps(c))
    else:
        print(c)
' "$filter"
  fi
}

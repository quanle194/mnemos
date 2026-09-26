#!/usr/bin/env bash
# Production smoke test through the public edge (Caddy):
#   web root + SPA fallback, /api/health/live, /api/health/ready (db+redis), metrics not public,
#   bootstrap (or reuse) a smoke tenant, ingest an experience, wait until it is learned into an ACTIVE memory,
#   retrieve it via /v1/context as a DIFFERENT agent, and check that postgres/redis are not reachable from outside.
set -Eeuo pipefail

SCRIPT_NAME=smoke-prod.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  cat <<EOF
Usage: scripts/smoke-prod.sh [options]

Options:
  --base-url URL          public base URL (default: derived from SITE_ADDRESS/HTTP_PORT in the env file,
                          else http://localhost)
  --env-file PATH         env file used for defaults (API_BOOTSTRAP_SECRET, SITE_ADDRESS) (default: <repo>/.env)
  --api-key KEY           use an existing ADMIN API key (or MNEMOS_API_KEY) instead of bootstrapping
  --bootstrap-secret S    bootstrap secret (or API_BOOTSTRAP_SECRET; default: read from the env file)
  --key-file PATH         reuse the smoke admin key stored here; bootstrap once and store it (mode 600) if absent
  --project NAME          compose project for the container port-exposure check (default: mnemos)
  --timeout SEC           max seconds to wait for learning (default: 180)
  --skip-port-check       skip the "postgres/redis not reachable" checks
  --extra-closed-port N   additional host port that must NOT be reachable (repeatable)
  --insecure              accept invalid TLS certificates (staging certificates only)
  -h, --help              show this help

Each run uses a fresh workspace (smoke-<run id>) inside a dedicated smoke organization, so production tenants are
never touched. Exit status is non-zero if any check fails.
EOF
}

BASE_URL_OPT=""
API_KEY=${MNEMOS_API_KEY:-}
SECRET=${API_BOOTSTRAP_SECRET:-}
KEY_FILE=""
TIMEOUT=180
CHECK_PORTS=1
INSECURE=0
EXTRA_PORTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL_OPT=${2:?}; shift 2 ;;
    --env-file) MNEMOS_ENV_FILE=$(abspath "${2:?}"); shift 2 ;;
    --api-key) API_KEY=${2:?}; shift 2 ;;
    --bootstrap-secret) SECRET=${2:?}; shift 2 ;;
    --key-file) KEY_FILE=${2:?}; shift 2 ;;
    --project) MNEMOS_PROJECT=${2:?}; shift 2 ;;
    --timeout) TIMEOUT=${2:?}; shift 2 ;;
    --skip-port-check) CHECK_PORTS=0; shift ;;
    --extra-closed-port) EXTRA_PORTS+=("${2:?}"); shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

require_cmd curl
have_cmd jq || have_cmd python3 || die "jq or python3 is required for JSON parsing"

if [[ -f "$MNEMOS_ENV_FILE" ]]; then
  [[ -n "$SECRET" ]] || SECRET=$(env_get API_BOOTSTRAP_SECRET "")
fi
if [[ -n "$BASE_URL_OPT" ]]; then
  BASE=${BASE_URL_OPT%/}
elif [[ -f "$MNEMOS_ENV_FILE" ]]; then
  BASE=$(default_base_url)
else
  BASE=http://localhost
fi

RUN_ID="$(date -u +%Y%m%d%H%M%S)-$RANDOM"
TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
REPORT=()
record() { # record STATUS NAME DETAIL
  local status=$1 name=$2 detail=${3-}
  if [[ "$status" == PASS ]]; then PASS=$((PASS + 1)); ok "$name ${detail:+- $detail}"; else FAIL=$((FAIL + 1)); err "$name ${detail:+- $detail}"; fi
  REPORT+=("$(printf '%-4s  %-28s %s' "$status" "$name" "$detail")")
}

finish() {
  printf '\nMnemos smoke report  (%s, run %s)\n' "$BASE" "$RUN_ID"
  printf '%s\n' "------------------------------------------------------------------------------"
  printf '%s\n' "${REPORT[@]}"
  printf '%s\n' "------------------------------------------------------------------------------"
  printf 'passed=%d failed=%d\n' "$PASS" "$FAIL"
  if [[ $FAIL -gt 0 ]]; then exit 1; fi
  exit 0
}

# http METHOD PATH [JSON_BODY] -> sets HTTP_CODE, HTTP_BODY. Secrets travel in a 0600 header file, not argv.
HTTP_CODE=""
HTTP_BODY=""
http() {
  local method=$1 path=$2 body=${3-}
  local hdr="$TMP/headers" out="$TMP/body"
  : >"$hdr"
  printf 'Accept: application/json\n' >>"$hdr"
  [[ -n "$API_KEY" ]] && printf 'Authorization: Bearer %s\n' "$API_KEY" >>"$hdr"
  [[ -n "${EXTRA_HEADER:-}" ]] && printf '%s\n' "$EXTRA_HEADER" >>"$hdr"
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method" -H "@$hdr" --max-time 30)
  [[ $INSECURE -eq 1 ]] && args+=(-k)
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary "@-")
    HTTP_CODE=$(printf '%s' "$body" | curl "${args[@]}" "$BASE$path" 2>"$TMP/curl.err") || HTTP_CODE="000"
  else
    HTTP_CODE=$(curl "${args[@]}" "$BASE$path" 2>"$TMP/curl.err") || HTTP_CODE="000"
  fi
  HTTP_BODY=$(cat "$out" 2>/dev/null || true)
  if [[ "$HTTP_CODE" == "000" ]]; then HTTP_BODY="curl: $(tr '\n' ' ' <"$TMP/curl.err")"; fi
}

jf() { json_get "$1" <<<"$HTTP_BODY" 2>/dev/null | head -n 1; }
short() { printf '%s' "${1:0:160}" | tr '\n' ' '; }

log "base URL: $BASE  (run $RUN_ID)"

# ------------------------------------------------------------------------------------------------- 1. web
http GET /
if [[ "$HTTP_CODE" == 200 && "$HTTP_BODY" == *'id="root"'* ]]; then
  record PASS "web root" "HTTP 200, SPA shell served"
else
  record FAIL "web root" "HTTP $HTTP_CODE $(short "$HTTP_BODY")"
fi
http GET /memories/smoke-deep-link
if [[ "$HTTP_CODE" == 200 && "$HTTP_BODY" == *'id="root"'* ]]; then
  record PASS "web SPA fallback" "deep link -> index.html"
else
  record FAIL "web SPA fallback" "HTTP $HTTP_CODE"
fi

# ------------------------------------------------------------------------------------------------- 2. health
http GET /api/health/live
if [[ "$HTTP_CODE" == 200 && "$(jf .status)" == ok ]]; then
  record PASS "api live" "/api/health/live ok"
else
  record FAIL "api live" "HTTP $HTTP_CODE $(short "$HTTP_BODY")"
fi

http GET /api/health/ready
if [[ "$HTTP_CODE" == 200 && "$(jf .checks.database.ok)" == true && "$(jf .checks.redis.ok)" == true ]]; then
  record PASS "api ready (db+redis)" "migration=$(jf .checks.database.migration) pgvector=$(jf .checks.database.pgvector) llm=$(jf .checks.providers.llm)"
else
  record FAIL "api ready (db+redis)" "HTTP $HTTP_CODE $(short "$HTTP_BODY")"
fi

http GET /api/metrics
if [[ "$HTTP_CODE" == 404 ]]; then
  record PASS "metrics not public" "/api/metrics -> 404 at the edge"
else
  record FAIL "metrics not public" "/api/metrics returned HTTP $HTTP_CODE (must stay internal)"
fi

# ------------------------------------------------------------------------------------------------- 3. tenant
WORKSPACE_ID=""
if [[ -z "$API_KEY" && -n "$KEY_FILE" && -s "$KEY_FILE" ]]; then
  API_KEY=$(head -n 1 "$KEY_FILE")
  log "using smoke admin key from $KEY_FILE"
fi
if [[ -n "$API_KEY" ]]; then
  http POST /api/v1/workspaces "{\"name\":\"smoke-$RUN_ID\"}"
  WORKSPACE_ID=$(jf .id)
  if [[ "$HTTP_CODE" == 201 && -n "$WORKSPACE_ID" ]]; then
    record PASS "tenant (existing key)" "workspace smoke-$RUN_ID created"
  else
    record FAIL "tenant (existing key)" "creating a workspace needs an ADMIN key: HTTP $HTTP_CODE $(short "$HTTP_BODY")"
  fi
elif [[ -n "$SECRET" ]]; then
  EXTRA_HEADER="X-Bootstrap-Secret: $SECRET"
  http POST /api/v1/admin/bootstrap "{\"organization_name\":\"mnemos-smoke\",\"workspace_name\":\"smoke-$RUN_ID\"}"
  EXTRA_HEADER=""
  API_KEY=$(jf .api_key)
  WORKSPACE_ID=$(jf .workspace_id)
  if [[ "$HTTP_CODE" == 201 && -n "$API_KEY" && -n "$WORKSPACE_ID" ]]; then
    record PASS "tenant bootstrap" "organization mnemos-smoke, workspace smoke-$RUN_ID"
    if [[ -n "$KEY_FILE" ]]; then
      (umask 077 && mkdir -p "$(dirname "$KEY_FILE")" && printf '%s\n' "$API_KEY" >"$KEY_FILE")
      log "stored smoke admin key in $KEY_FILE (reused by later runs)"
    fi
  else
    record FAIL "tenant bootstrap" "HTTP $HTTP_CODE $(short "$HTTP_BODY")"
  fi
else
  record FAIL "tenant" "no API key and no bootstrap secret (use --api-key, --bootstrap-secret or --env-file)"
fi
[[ -n "$WORKSPACE_ID" && -n "$API_KEY" ]] || finish

# ------------------------------------------------------------------------------------------------- 4. ingest
EXP_BODY=$(cat <<EOF
{"workspace_id":"$WORKSPACE_ID","project_name":"smoke","agent_name":"smoke-agent-a","task_id":"smoke-$RUN_ID",
 "task":"Deploy billing-api to staging",
 "observation":"Deployment failed: database migration timed out because the orders table was locked by the nightly batch job.",
 "action":"Paused the batch job with batchctl pause and re-ran the migration with --lock-timeout=5s.",
 "result":"Migration applied and the billing-api deployment succeeded.",
 "outcome":"success","metadata":{"smoke_run":"$RUN_ID"}}
EOF
)
EXTRA_HEADER="Idempotency-Key: smoke-$RUN_ID"
http POST /api/v1/experiences "$EXP_BODY"
EXTRA_HEADER=""
EXP_ID=$(jf .experience.id)
if [[ "$HTTP_CODE" == 201 && -n "$EXP_ID" ]]; then
  record PASS "ingest experience" "experience $EXP_ID queued (job $(jf .learning.job_id))"
else
  record FAIL "ingest experience" "HTTP $HTTP_CODE $(short "$HTTP_BODY")"
  finish
fi

# ------------------------------------------------------------------------------------------------- 5. learn
start=$SECONDS
MEM_ID=""
STATUS=""
while (( SECONDS - start < TIMEOUT )); do
  http GET "/api/v1/experiences/$EXP_ID"
  STATUS=$(jf .processing_status)
  if [[ "$HTTP_CODE" == 200 && "$STATUS" == processed ]]; then
    if have_cmd jq; then
      MEM_ID=$(jq -r '[.learning.memories[]? | select(.status == "active") | .id][0] // empty' <<<"$HTTP_BODY")
    else
      MEM_ID=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((m["id"] for m in (d.get("learning") or {}).get("memories", []) if m.get("status")=="active"), ""))' <<<"$HTTP_BODY")
    fi
    [[ -n "$MEM_ID" ]] && break
  elif [[ "$STATUS" == failed ]]; then
    break
  fi
  sleep 2
done
if [[ -n "$MEM_ID" ]]; then
  record PASS "learn -> active memory" "memory $MEM_ID active after $((SECONDS - start))s"
else
  record FAIL "learn -> active memory" "processing_status=${STATUS:-?} after $((SECONDS - start))s (is the worker healthy?) $(short "$HTTP_BODY")"
  finish
fi

# ------------------------------------------------------------------------------------------------- 6. retrieve
http POST "/api/v1/workspaces/$WORKSPACE_ID/agents" '{"name":"smoke-agent-b"}'
AGENT_B=$(jf .id)
http GET "/api/v1/workspaces/$WORKSPACE_ID/projects"
if have_cmd jq; then
  PROJECT_ID=$(jq -r '[.[] | select(.name == "smoke") | .id][0] // empty' <<<"$HTTP_BODY")
else
  PROJECT_ID=$(python3 -c 'import json,sys; print(next((p["id"] for p in json.load(sys.stdin) if p.get("name")=="smoke"), ""))' <<<"$HTTP_BODY")
fi
if [[ -z "$AGENT_B" || -z "$PROJECT_ID" ]]; then
  record FAIL "retrieve (agent B)" "could not create agent B or find project: $(short "$HTTP_BODY")"
  finish
fi
CTX_BODY="{\"workspace_id\":\"$WORKSPACE_ID\",\"project_id\":\"$PROJECT_ID\",\"agent_id\":\"$AGENT_B\",\"query\":\"deploy billing-api to staging migration\",\"token_budget\":800}"
http POST /api/v1/context "$CTX_BODY"
if [[ "$HTTP_CODE" == 200 ]] && json_get '.memories[].id' <<<"$HTTP_BODY" | grep -qx "$MEM_ID"; then
  record PASS "retrieve (agent B)" "memory $MEM_ID in context, ~$(jf .token_estimate) tokens, trace $(jf .retrieval_trace_id)"
else
  record FAIL "retrieve (agent B)" "HTTP $HTTP_CODE memory $MEM_ID not returned: $(short "$HTTP_BODY")"
fi

# ------------------------------------------------------------------------------------------------- 7. exposure
port_open() { # port_open HOST PORT
  if have_cmd nc; then
    nc -z -w 2 "$1" "$2" >/dev/null 2>&1
  else
    timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
  fi
}
if [[ $CHECK_PORTS -eq 1 ]]; then
  host=${BASE#*://}
  host=${host%%/*}
  if [[ "$host" == \[* ]]; then host=${host%%]*}; host=${host#[}; else host=${host%%:*}; fi
  specs=("5432:postgres" "6379:redis")
  for port in "${EXTRA_PORTS[@]}"; do specs+=("$port:extra"); done
  for spec in "${specs[@]}"; do
    port=${spec%%:*}
    name=${spec#*:}
    if port_open "$host" "$port"; then
      record FAIL "port $port closed" "$name port $port is reachable on $host - it must not be published"
    else
      record PASS "port $port closed" "$name not reachable on $host"
    fi
  done
  if have_cmd docker && docker info >/dev/null 2>&1; then
    published=$(docker ps --filter "label=com.docker.compose.project=$MNEMOS_PROJECT" \
      --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | awk '$0 ~ /->/ && $1 != "caddy" {print $1}' | sort -u | tr '\n' ' ')
    count=$(docker ps -q --filter "label=com.docker.compose.project=$MNEMOS_PROJECT" | wc -l)
    if [[ $count -eq 0 ]]; then
      log "no containers for compose project '$MNEMOS_PROJECT' on this host - skipping published-port audit"
    elif [[ -z "$published" ]]; then
      record PASS "only caddy publishes" "project $MNEMOS_PROJECT: $count containers, no other published ports"
    else
      record FAIL "only caddy publishes" "services with published host ports: $published"
    fi
  fi
fi

finish

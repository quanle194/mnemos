#!/usr/bin/env bash
# Restore a Mnemos PostgreSQL backup.
#
#  --verify (DEFAULT)  restore into an ISOLATED throwaway postgres container (same pgvector image, --network none,
#                      anonymous volume, no published ports) and prove the backup is usable:
#                      checksum, alembic revision (== manifest, == deployed code head), core tables, row counts ==
#                      manifest counts, pgvector extension + vector operator. The container is always removed.
#  --target live       replace the database of the running stack (stops api/worker/mcp, safety backup, restore,
#                      migrate, restart, health check). Requires --yes (plus a typed confirmation on a TTY).
set -Eeuo pipefail

SCRIPT_NAME=restore.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage: scripts/restore.sh [--verify | --target live] [--file DUMP | --latest] [options]

Modes:
  --verify               isolated restore verification (default)
  --target live          restore into the running stack's database (DESTRUCTIVE)

Backup selection:
  --file PATH            dump file (mnemos-*.dump); its .sha256 and .manifest.json are expected next to it
  --latest               newest dump in the backup directory (default when --file is not given)
  --dir DIR              backup directory (default: BACKUP_DIR from the env file, else ./backups)

Options:
  --allow-older-schema   (verify) accept a dump whose alembic revision differs from the deployed code head
                         (e.g. a backup taken before an upgrade; run migrations after restoring it)
  --keep-container       (verify) keep the throwaway container for inspection (remove it manually afterwards)
  --yes                  (live) confirm the destructive restore non-interactively
  --skip-verify          (live) skip the isolated verification that normally runs first
  --skip-safety-backup   (live) do not back up the current database before overwriting it
  --env-file PATH        env file (default: <repo>/.env)
  --project NAME         compose project (default: mnemos)
  -h, --help             show this help
EOF
}

MODE=verify
FILE=""
DIR_OPT=""
ALLOW_OLDER=0
KEEP_CONTAINER=0
YES=0
SKIP_VERIFY=0
SKIP_SAFETY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) MODE=verify; shift ;;
    --target)
      case "${2:-}" in
        live) MODE=live ;;
        isolated|verify) MODE=verify ;;
        *) die "--target must be 'live' (or 'isolated')" ;;
      esac
      shift 2 ;;
    --file) FILE=${2:?}; shift 2 ;;
    --latest) FILE=""; shift ;;
    --dir) DIR_OPT=${2:?}; shift 2 ;;
    --allow-older-schema) ALLOW_OLDER=1; shift ;;
    --keep-container) KEEP_CONTAINER=1; shift ;;
    --yes) YES=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --skip-safety-backup) SKIP_SAFETY=1; shift ;;
    --env-file) MNEMOS_ENV_FILE=${2:?}; shift 2 ;;
    --project) MNEMOS_PROJECT=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

require_docker
require_env_file
require_cmd sha256sum
have_cmd jq || have_cmd python3 || die "jq or python3 is required"

DIR=$(abspath "${DIR_OPT:-$(backup_dir)}")
if [[ -z "$FILE" ]]; then
  FILE=$(find "$DIR" -maxdepth 1 -type f -name 'mnemos-*.dump' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
  [[ -n "$FILE" ]] || die "no mnemos-*.dump backups found in $DIR"
  FILE="$DIR/$FILE"
fi
FILE=$(abspath "$FILE")
[[ -s "$FILE" ]] || die "dump not found or empty: $FILE"
BASE=${FILE%.dump}
MANIFEST="$BASE.manifest.json"
PGU=$(pg_user)
PGD=$(pg_db)

manifest_get() { json_get "$1" <"$MANIFEST"; }

check_checksum() {
  if [[ -f "$FILE.sha256" ]]; then
    (cd "$(dirname "$FILE")" && sha256sum --quiet -c "$(basename "$FILE").sha256") \
      || die "checksum mismatch for $FILE"
    ok "sha256 checksum matches"
  else
    warn "no checksum file ($FILE.sha256) - integrity not verified"
  fi
}

# Alembic head(s) of the deployed application image (empty when the image is not available locally).
code_head() {
  local image
  image=$(app_image "$(current_version)")
  docker image inspect "$image" >/dev/null 2>&1 || return 0
  docker run --rm --network none --entrypoint python "$image" -c '
from alembic.config import Config
from alembic.script import ScriptDirectory
print(",".join(sorted(ScriptDirectory.from_config(Config("/app/backend/alembic.ini")).get_heads())))' 2>/dev/null || true
}

# ================================================================================================= verify
CHECKS=()
FAILED=0
check() { # check PASS|FAIL|WARN NAME DETAIL
  CHECKS+=("$1|$2|$3")
  case "$1" in
    PASS) ok "$2: $3" ;;
    WARN) warn "$2: $3" ;;
    *) FAILED=1; err "$2: $3" ;;
  esac
}

write_verify_report() {
  local out="$BASE.verify.json" result=$1 image=$2
  if have_cmd jq; then
    printf '%s\n' "${CHECKS[@]}" | jq -R -s --arg file "$(basename "$FILE")" --arg result "$result" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg image "$image" \
      '{file: $file, verified_at: $at, result: $result, postgres_image: $image,
        checks: (split("\n") | map(select(length > 0) | split("|") | {status: .[0], check: .[1], detail: .[2]}))}' \
      >"$out"
  else
    printf '%s\n' "${CHECKS[@]}" | python3 -c '
import json, sys
rows = [l.rstrip("\n").split("|", 2) for l in sys.stdin if l.strip()]
json.dump({"file": sys.argv[1], "verified_at": sys.argv[2], "result": sys.argv[3], "postgres_image": sys.argv[4],
           "checks": [{"status": s, "check": c, "detail": d} for s, c, d in rows]}, open(sys.argv[5], "w"), indent=2)
' "$(basename "$FILE")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$result" "$image" "$out"
  fi
  chmod 600 "$out"
  log "verification report: $out"
}

verify_isolated() {
  banner "isolated restore verification of $(basename "$FILE")"
  check_checksum
  [[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST (row counts cannot be verified)"

  local image name pw
  image=$(pg_image)
  name="${MNEMOS_PROJECT}-restore-verify-$(date +%s)-$RANDOM"
  pw=$(openssl rand -hex 16 2>/dev/null || date +%s%N)
  if [[ $KEEP_CONTAINER -eq 0 ]]; then
    # shellcheck disable=SC2064  # expand now: the name is fixed
    trap "docker rm -f -v '$name' >/dev/null 2>&1 || true" EXIT
  fi
  log "starting throwaway container $name ($image, --network none, anonymous volume)"
  docker run -d --name "$name" --network none --label mnemos.restore-verify=1 --shm-size 256m \
    -e POSTGRES_USER="$PGU" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB="$PGD" "$image" >/dev/null

  local ready=0
  for _ in $(seq 1 90); do
    if docker exec "$name" pg_isready -q -h 127.0.0.1 -U "$PGU" -d "$PGD" 2>/dev/null; then ready=1; break; fi
    sleep 1
  done
  [[ $ready -eq 1 ]] || die "throwaway postgres did not become ready (see: docker logs $name)"

  local started=$SECONDS
  if docker exec -i "$name" pg_restore -U "$PGU" -d "$PGD" --no-owner --exit-on-error --single-transaction \
      <"$FILE" 2>"$BASE.restore.log.partial"; then
    check PASS "pg_restore" "restored in $((SECONDS - started))s into isolated database"
    rm -f "$BASE.restore.log.partial"
  else
    check FAIL "pg_restore" "$(tail -n 3 "$BASE.restore.log.partial" | tr '\n' ' ')"
    rm -f "$BASE.restore.log.partial"
    write_verify_report fail "$image"
    exit 1
  fi

  q() { docker exec "$name" psql -X -A -t -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" -c "$1"; }

  # alembic revision
  local rev expected head
  rev=$(q "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version" 2>/dev/null || true)
  expected=$(manifest_get .alembic_version)
  if [[ -z "$rev" ]]; then
    check FAIL "alembic_version" "table missing or empty"
  elif [[ "$rev" != "$expected" ]]; then
    check FAIL "alembic_version" "restored '$rev' != manifest '$expected'"
  else
    check PASS "alembic_version" "$rev (matches manifest)"
  fi
  head=$(code_head)
  [[ -n "$head" ]] || { service_running postgres && head=$(psql_live "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version" 2>/dev/null || true); }
  if [[ -z "$head" ]]; then
    check WARN "schema == live head" "could not determine the live head (app image $(app_image "$(current_version)") not present, stack not running)"
  elif [[ "$rev" == "$head" ]]; then
    check PASS "schema == live head" "$head"
  elif [[ $ALLOW_OLDER -eq 1 ]]; then
    check WARN "schema == live head" "dump at '$rev', live head '$head' (allowed; run \`mnemos migrate\` after restoring)"
  else
    check FAIL "schema == live head" "dump at '$rev' but live head is '$head' (use --allow-older-schema for pre-upgrade backups)"
  fi

  # core tables
  local core=(alembic_version organizations workspaces projects agents api_keys experiences episodes memories
    memory_versions memory_evidence memory_relations audit_logs jobs retrieval_traces)
  local have missing=()
  have=$(q "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
  for t in "${core[@]}"; do grep -qx "$t" <<<"$have" || missing+=("$t"); done
  if [[ ${#missing[@]} -eq 0 ]]; then
    check PASS "core tables" "${#core[@]} present"
  else
    check FAIL "core tables" "missing: ${missing[*]}"
  fi

  # row counts vs manifest (captured in the dump's own snapshot)
  local tables t want got mismatches=() summary=""
  mapfile -t tables < <(if have_cmd jq; then jq -r '.counts | keys[]' "$MANIFEST"; else
    python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))["counts"])))' "$MANIFEST"; fi)
  for t in "${tables[@]}"; do
    want=$(manifest_get ".counts.$t")
    got=$(q "SELECT count(*) FROM public.\"$t\"" 2>/dev/null || echo "missing")
    [[ "$got" == "$want" ]] || mismatches+=("$t: dump=$got manifest=$want")
    summary+="$t=$got "
  done
  if [[ ${#tables[@]} -eq 0 ]]; then
    check FAIL "row counts" "manifest has no counts"
  elif [[ ${#mismatches[@]} -eq 0 ]]; then
    check PASS "row counts == manifest" "${summary% }"
  else
    check FAIL "row counts == manifest" "${mismatches[*]}"
  fi

  # pgvector
  local ext dist
  ext=$(q "SELECT extversion FROM pg_extension WHERE extname = 'vector'" || true)
  dist=$(q "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector" 2>/dev/null || true)
  if [[ -n "$ext" && "$dist" == "1" ]]; then
    check PASS "pgvector" "extension $ext, vector distance operator works"
  else
    check FAIL "pgvector" "extension='${ext}' distance='${dist}'"
  fi
  local emb
  emb=$(q "SELECT count(*) FROM memories WHERE embedding IS NOT NULL" 2>/dev/null || echo "?")
  log "memories with embeddings: $emb"

  if [[ $FAILED -eq 0 ]]; then
    write_verify_report pass "$image"
    ok "backup $(basename "$FILE") VERIFIED by isolated restore"
  else
    write_verify_report fail "$image"
    die "backup $(basename "$FILE") FAILED verification"
  fi
  if [[ $KEEP_CONTAINER -eq 1 ]]; then
    warn "kept container $name - remove with: docker rm -f -v $name"
  fi
}

# ================================================================================================= live
restore_live() {
  check_checksum
  local created rev counts
  if [[ -f "$MANIFEST" ]]; then
    created=$(manifest_get .created_at)
    rev=$(manifest_get .alembic_version)
    counts=$(if have_cmd jq; then jq -c .counts "$MANIFEST"; else python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["counts"]))' "$MANIFEST"; fi)
  fi
  service_running postgres || die "postgres service of project '$MNEMOS_PROJECT' is not running (start it: compose up -d postgres)"

  if [[ $SKIP_VERIFY -eq 0 ]]; then
    # Older schema revisions are fine here: migrations run right after the restore.
    "$MNEMOS_ROOT/scripts/restore.sh" --verify --allow-older-schema --file "$FILE" --dir "$DIR" \
      --env-file "$MNEMOS_ENV_FILE" --project "$MNEMOS_PROJECT" \
      || die "isolated verification failed - refusing to restore this dump into the live database"
  fi

  cat >&2 <<EOF

${_C_RED}${_C_BLD}################################################################################
#  DESTRUCTIVE: LIVE DATABASE RESTORE
#  project : $MNEMOS_PROJECT
#  database: $PGD  (ALL current data will be REPLACED)
#  dump    : $FILE
#  taken at: ${created:-unknown}   alembic: ${rev:-unknown}
#  counts  : ${counts:-unknown}
################################################################################${_C_RST}

EOF
  if [[ $YES -ne 1 ]]; then
    [[ -t 0 ]] || die "refusing to restore into the live database without --yes"
    local answer
    read -r -p "Type the project name ('$MNEMOS_PROJECT') to continue: " answer
    [[ "$answer" == "$MNEMOS_PROJECT" ]] || die "confirmation did not match - aborted"
  else
    local n=${RESTORE_COUNTDOWN:-10}
    while (( n > 0 )); do printf '\rrestoring in %2ds - Ctrl-C to abort ' "$n" >&2; sleep 1; n=$((n - 1)); done
    printf '\n' >&2
  fi

  if [[ $SKIP_SAFETY -eq 0 ]]; then
    log "safety backup of the current database first"
    "$MNEMOS_ROOT/scripts/backup.sh" --label pre-restore --keep-days 0 --no-offsite \
      --env-file "$MNEMOS_ENV_FILE" --project "$MNEMOS_PROJECT" --dir "$DIR" >/dev/null \
      || die "safety backup failed - aborting before touching the database"
  fi

  local running=() s
  for s in api worker mcp; do service_running "$s" && running+=("$s"); done
  if [[ ${#running[@]} -gt 0 ]]; then
    log "stopping writers: ${running[*]}"
    compose stop "${running[@]}"
  fi

  log "recreating database $PGD"
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -q -U "$PGU" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$PGD\" WITH (FORCE);" -c "CREATE DATABASE \"$PGD\" OWNER \"$PGU\";"
  log "pg_restore into $PGD ..."
  compose exec -T postgres pg_restore -U "$PGU" -d "$PGD" --no-owner --exit-on-error --single-transaction <"$FILE"
  ok "restore complete"

  log "applying migrations (no-op when the dump is already at head)"
  compose run --rm --no-deps migrate

  local start=(api worker)
  [[ " ${running[*]} " == *" mcp "* ]] && start+=(mcp)
  log "starting ${start[*]}"
  compose up -d --wait --wait-timeout 180 "${start[@]}"

  if [[ -f "$MANIFEST" ]]; then
    local t want got bad=0
    while read -r t; do
      want=$(manifest_get ".counts.$t")
      got=$(psql_live "SELECT count(*) FROM public.\"$t\"")
      if [[ "$got" != "$want" ]]; then warn "row count $t: live=$got manifest=$want"; bad=1; fi
    done < <(if have_cmd jq; then jq -r '.counts | keys[]' "$MANIFEST"; else
      python3 -c 'import json,sys; print("\n".join(sorted(json.load(open(sys.argv[1]))["counts"])))' "$MANIFEST"; fi)
    [[ $bad -eq 0 ]] && ok "live row counts match the manifest"
  fi
  ok "live restore finished. Verify with: scripts/smoke-prod.sh --env-file $MNEMOS_ENV_FILE"
}

if [[ "$MODE" == verify ]]; then
  verify_isolated
else
  restore_live
fi

#!/usr/bin/env bash
# Consistent PostgreSQL backup of the running Mnemos stack.
#
#  * custom-format dump (pg_dump -Fc) taken through `docker compose exec -T postgres`
#  * row counts + alembic revision captured in the SAME exported snapshot as the dump (manifest JSON), so an isolated
#    restore can prove the dump is complete (scripts/restore.sh --verify)
#  * sha256 checksum, `pg_restore -l` TOC verification, retention pruning, optional Redis RDB copy, optional
#    off-site hook. Prints the dump path as the last line on stdout.
set -Eeuo pipefail

SCRIPT_NAME=backup.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage: scripts/backup.sh [options]

Options:
  --label TEXT       suffix for the file name, e.g. pre-deploy-v1.2.0 ([A-Za-z0-9._-])
  --dir DIR          backup directory (default: BACKUP_DIR from the env file, else ./backups)
  --keep-days N      delete backups older than N days (default: BACKUP_KEEP_DAYS or 14; 0 disables pruning)
  --keep-min N       always keep the N newest backups (default: BACKUP_KEEP_MIN or 3)
  --with-redis       also copy a fresh Redis RDB snapshot (Redis only holds ephemeral state; optional)
  --verify           after the dump, run an isolated restore verification (scripts/restore.sh --verify)
  --no-offsite       do not run BACKUP_OFFSITE_CMD even if configured
  --env-file PATH    env file (default: <repo>/.env)
  --project NAME     compose project (default: mnemos)
  -h, --help         show this help

Files written (mode 600, directory mode 700):
  mnemos-<project>-<UTC timestamp>[-label].dump            pg_dump custom format
  ...dump.sha256                                            checksum (sha256sum -c compatible)
  ...manifest.json                                          alembic revision, row counts, versions, checksum
  ...redis.rdb                                              with --with-redis
EOF
}

LABEL=""
DIR_OPT=""
KEEP_DAYS=""
KEEP_MIN=""
WITH_REDIS=0
VERIFY=0
OFFSITE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL=${2:?}; shift 2 ;;
    --dir) DIR_OPT=${2:?}; shift 2 ;;
    --keep-days) KEEP_DAYS=${2:?}; shift 2 ;;
    --keep-min) KEEP_MIN=${2:?}; shift 2 ;;
    --with-redis) WITH_REDIS=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --no-offsite) OFFSITE=0; shift ;;
    --env-file) MNEMOS_ENV_FILE=${2:?}; shift 2 ;;
    --project) MNEMOS_PROJECT=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

require_docker
require_env_file
require_cmd sha256sum flock find
have_cmd jq || have_cmd python3 || die "jq or python3 is required"

[[ -z "$LABEL" || "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --label '$LABEL'"
KEEP_DAYS=${KEEP_DAYS:-$(env_get BACKUP_KEEP_DAYS 14)}
KEEP_MIN=${KEEP_MIN:-$(env_get BACKUP_KEEP_MIN 3)}
[[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_MIN" =~ ^[0-9]+$ ]] || die "--keep-days/--keep-min must be integers"

DIR=${DIR_OPT:-$(backup_dir)}
DIR=$(abspath "$DIR")
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true

exec 9>"$DIR/.backup.lock"
flock -n 9 || die "another backup is running (lock $DIR/.backup.lock)"

service_running postgres || die "postgres service of project '$MNEMOS_PROJECT' is not running"

PGU=$(pg_user)
PGD=$(pg_db)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE="mnemos-${MNEMOS_PROJECT}-${STAMP}${LABEL:+-$LABEL}"
DUMP="$DIR/$BASE.dump"
PART="$DUMP.partial"
MANIFEST="$DIR/$BASE.manifest.json"
KEY_TABLES=(organizations workspaces projects agents api_keys experiences episodes memories memory_versions
  memory_evidence memory_relations memory_feedback conflicts dream_jobs audit_logs)

cleanup() {
  rm -f "$PART" "$DIR/$BASE.meta.partial"
  if [[ -n "${PSQL_IN:-}" ]]; then exec {PSQL_IN}>&- 2>/dev/null || true; fi
}
trap cleanup EXIT

banner "backup $MNEMOS_PROJECT/$PGD -> $DUMP"

# --- 1. open a REPEATABLE READ transaction, export its snapshot, record counts inside it -----------------------
coproc PSQL { compose exec -T postgres psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" 2>&1; }
exec {PSQL_IN}>&"${PSQL[1]}" {PSQL_OUT}<&"${PSQL[0]}"

psql_line() { # psql_line SQL -> first output line (30s timeout)
  local line
  printf '%s\n' "$1" >&"$PSQL_IN"
  IFS= read -r -t 30 -u "$PSQL_OUT" line || die "no answer from psql for: $1"
  printf '%s\n' "$line"
}

printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' >&"$PSQL_IN"
SNAPSHOT=$(psql_line "SELECT pg_export_snapshot();")
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]] || die "could not export snapshot: $SNAPSHOT"

in_list=$(printf "'%s'," "${KEY_TABLES[@]}")
existing=$(psql_line "SELECT coalesce(string_agg(tablename, ',' ORDER BY tablename), '') FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${in_list%,});")
has_alembic=$(psql_line "SELECT to_regclass('public.alembic_version') IS NOT NULL;")

count_expr=""
IFS=',' read -r -a present <<<"$existing"
for t in "${present[@]}"; do
  [[ -n "$t" ]] && count_expr+="'$t', (SELECT count(*) FROM public.\"$t\"),"
done
alembic_expr="NULL"
[[ "$has_alembic" == t ]] && alembic_expr="(SELECT string_agg(version_num, ',') FROM public.alembic_version)"
META=$(psql_line "SELECT json_build_object(
  'alembic_version', $alembic_expr,
  'pgvector', (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
  'server_version', current_setting('server_version'),
  'database_size_bytes', pg_database_size(current_database()),
  'counts', json_build_object(${count_expr%,}))::text;")
[[ "$META" == \{* ]] || die "could not collect manifest data: $META"

# --- 2. dump inside the same snapshot ----------------------------------------------------------------------------
log "pg_dump -Fc (snapshot $SNAPSHOT) ..."
started=$SECONDS
compose exec -T postgres pg_dump -U "$PGU" -d "$PGD" -Fc -Z 6 --snapshot="$SNAPSHOT" >"$PART"
printf 'COMMIT;\n\\q\n' >&"$PSQL_IN"
exec {PSQL_IN}>&-
PSQL_IN=""
wait "$PSQL_PID" 2>/dev/null || true
[[ -s "$PART" ]] || die "pg_dump produced an empty file"
DUMP_SECONDS=$((SECONDS - started))

# --- 3. verify the archive TOC -----------------------------------------------------------------------------------
TOC=$(compose exec -T postgres pg_restore -l <"$PART") || die "pg_restore -l could not read the archive"
toc_entries=$(grep -cvE '^\s*(;|$)' <<<"$TOC" || true)
missing=()
for t in "${present[@]}"; do
  [[ -z "$t" ]] && continue
  grep -qE "TABLE DATA public ${t} " <<<"$TOC" || missing+=("$t")
done
[[ ${#missing[@]} -eq 0 ]] || die "archive TOC lacks table data for: ${missing[*]}"
if [[ "$has_alembic" == t ]] && ! grep -qE "TABLE DATA public alembic_version " <<<"$TOC"; then
  die "archive TOC lacks alembic_version data"
fi
ok "pg_restore -l: $toc_entries TOC entries, table data present for ${#present[@]} key tables"

mv -f "$PART" "$DUMP"
(cd "$DIR" && sha256sum "$BASE.dump" >"$BASE.dump.sha256")
SHA=$(cut -d' ' -f1 "$DIR/$BASE.dump.sha256")
SIZE=$(stat -c %s "$DUMP")

# --- 4. manifest ------------------------------------------------------------------------------------------------
APP_VERSION=${MNEMOS_VERSION:-$(env_get MNEMOS_VERSION latest)}
if have_cmd jq; then
  jq -n --argjson meta "$META" --arg file "$BASE.dump" --arg sha "$SHA" --argjson size "$SIZE" \
    --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg project "$MNEMOS_PROJECT" --arg db "$PGD" \
    --arg label "$LABEL" --arg app "$APP_VERSION" --arg snap "$SNAPSHOT" --argjson secs "$DUMP_SECONDS" \
    --argjson toc "$toc_entries" \
    '{format: "pg_dump-custom", file: $file, sha256: $sha, size_bytes: $size, created_at: $created,
      project: $project, database: $db, label: $label, app_version: $app, snapshot: $snap,
      dump_seconds: $secs, toc_entries: $toc} + $meta' >"$MANIFEST"
else
  META="$META" python3 - "$MANIFEST" <<PY
import json, os, sys
meta = json.loads(os.environ["META"])
doc = {"format": "pg_dump-custom", "file": "$BASE.dump", "sha256": "$SHA", "size_bytes": $SIZE,
       "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "project": "$MNEMOS_PROJECT", "database": "$PGD",
       "label": "$LABEL", "app_version": "$APP_VERSION", "snapshot": "$SNAPSHOT", "dump_seconds": $DUMP_SECONDS,
       "toc_entries": $toc_entries}
doc.update(meta)
with open(sys.argv[1], "w") as fh:
    json.dump(doc, fh, indent=2)
PY
fi
ok "dump $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes") in ${DUMP_SECONDS}s, sha256 ${SHA:0:16}..., manifest $(basename "$MANIFEST")"
log "manifest: $(tr -d '\n ' <"$MANIFEST" | cut -c1-400)"

# --- 5. optional redis snapshot ---------------------------------------------------------------------------------
if [[ $WITH_REDIS -eq 1 ]]; then
  if service_running redis; then
    rcli() { compose exec -T redis sh -c "REDISCLI_AUTH=\"\$REDIS_PASSWORD\" redis-cli $1" | tr -d '\r'; }
    before=$(rcli LASTSAVE)
    rcli BGSAVE >/dev/null
    for _ in $(seq 1 60); do
      [[ "$(rcli LASTSAVE)" != "$before" ]] && break
      sleep 1
    done
    if [[ "$(rcli LASTSAVE)" != "$before" ]]; then
      compose cp redis:/data/dump.rdb "$DIR/$BASE.redis.rdb" >/dev/null
      chmod 600 "$DIR/$BASE.redis.rdb"
      ok "redis RDB snapshot copied ($BASE.redis.rdb)"
    else
      warn "redis BGSAVE did not complete within 60s - RDB copy skipped"
    fi
  else
    warn "redis service not running - RDB copy skipped"
  fi
fi

# --- 6. retention ---------------------------------------------------------------------------------------------
if [[ "$KEEP_DAYS" -gt 0 ]]; then
  mapfile -t all < <(find "$DIR" -maxdepth 1 -type f -name "mnemos-${MNEMOS_PROJECT}-*.dump" -printf '%f\n' | sort -r)
  pruned=0
  for ((i = KEEP_MIN; i < ${#all[@]}; i++)); do
    f="$DIR/${all[$i]}"
    if [[ -n "$(find "$f" -maxdepth 0 -mtime "+$KEEP_DAYS" 2>/dev/null)" ]]; then
      b=${f%.dump}
      rm -f "$f" "$f.sha256" "$b.manifest.json" "$b.verify.json" "$b.redis.rdb"
      pruned=$((pruned + 1))
    fi
  done
  log "retention: kept newest $KEEP_MIN, pruned $pruned backup(s) older than $KEEP_DAYS days"
fi

# --- 7. optional isolated restore verification --------------------------------------------------------------------
if [[ $VERIFY -eq 1 ]]; then
  "$MNEMOS_ROOT/scripts/restore.sh" --verify --file "$DUMP" --env-file "$MNEMOS_ENV_FILE" --project "$MNEMOS_PROJECT" >&2
fi

# --- 8. optional off-site copy -------------------------------------------------------------------------------------
OFFSITE_CMD=${BACKUP_OFFSITE_CMD:-$(env_get BACKUP_OFFSITE_CMD "")}
if [[ $OFFSITE -eq 1 && -n "$OFFSITE_CMD" ]]; then
  log "running off-site hook: $OFFSITE_CMD"
  BACKUP_FILE="$DUMP" BACKUP_MANIFEST="$MANIFEST" BACKUP_CHECKSUM="$DUMP.sha256" BACKUP_DIR="$DIR" \
    bash -c "$OFFSITE_CMD" >&2 || die "off-site hook failed (local backup is intact: $DUMP)"
  ok "off-site hook completed"
fi

printf '%s\n' "$DUMP"

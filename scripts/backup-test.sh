#!/usr/bin/env bash
# Backup drill: take a fresh backup of the running stack, then prove it restores in an isolated database.
# Used by `make backup-test`. Exit status is non-zero unless the backup was written AND verified.
set -Eeuo pipefail

SCRIPT_NAME=backup-test.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage: scripts/backup-test.sh [--env-file PATH] [--project NAME] [--dir DIR] [--keep]

  1. scripts/backup.sh --label backup-test      (consistent pg_dump + manifest + checksum + TOC check)
  2. scripts/restore.sh --verify --file <dump>  (isolated throwaway postgres; schema, tables, counts, pgvector)

Options:
  --env-file PATH   env file (default: <repo>/.env)
  --project NAME    compose project (default: mnemos)
  --dir DIR         backup directory (default: BACKUP_DIR from the env file)
  --keep            keep the drill backup files (default: delete them after a successful verification)
  -h, --help        show this help
EOF
}

DIR_ARGS=()
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) MNEMOS_ENV_FILE=${2:?}; shift 2 ;;
    --project) MNEMOS_PROJECT=${2:?}; shift 2 ;;
    --dir) DIR_ARGS=(--dir "${2:?}"); shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

require_env_file
common=(--env-file "$MNEMOS_ENV_FILE" --project "$MNEMOS_PROJECT")

banner "backup drill: backup"
started=$SECONDS
dump=$("$MNEMOS_ROOT/scripts/backup.sh" --label backup-test --keep-days 0 --no-offsite "${DIR_ARGS[@]}" "${common[@]}" | tail -n 1)
[[ -s "$dump" ]] || die "backup.sh did not produce a dump"

banner "backup drill: isolated restore verification"
"$MNEMOS_ROOT/scripts/restore.sh" --verify --file "$dump" "${DIR_ARGS[@]}" "${common[@]}"

report="${dump%.dump}.verify.json"
ok "backup drill PASSED in $((SECONDS - started))s: $dump"
if [[ -f "$report" ]]; then
  log "verification report: $(tr -d '\n' <"$report" | cut -c1-300)..."
fi
if [[ $KEEP -eq 0 ]]; then
  rm -f "$dump" "$dump.sha256" "${dump%.dump}.manifest.json" "${dump%.dump}.verify.json"
  log "drill files removed (use --keep to retain them)"
fi

#!/usr/bin/env bash
# Upgrade to a new release, or roll the application back to a previous image.
#
# Upgrade  = (optional) check out a git ref -> scripts/deploy.sh (pre-migration backup, migrate, health gate, smoke).
# Rollback = start api/worker/web from a previous image tag WITHOUT running migrations (`up --no-deps`), after
#            checking that the target release knows the database's current alembic revision. When it does not
#            (a migration added after that release), the rollback is refused unless --force is given, because only
#            expand-phase (additive) migrations are safe to run under older code. Otherwise restore the
#            pre-migration backup with scripts/restore.sh --target live.
set -Eeuo pipefail

SCRIPT_NAME=upgrade.sh
# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
install_err_trap

usage() {
  cat <<EOF
Usage:
  scripts/upgrade.sh [--ref GIT_REF] [--allow-dirty] [deploy.sh options...]
  scripts/upgrade.sh --rollback [--to VERSION] [--force] [--skip-smoke] [--env-file PATH] [--project NAME]

Upgrade options:
  --ref REF          git tag/branch/commit to deploy (fetched from origin); default: current checkout
  --allow-dirty      allow uncommitted changes in the checkout
  (all other options are passed to scripts/deploy.sh, e.g. --version, --no-build, --with-mcp)

Rollback options:
  --rollback         roll the application images back
  --to VERSION       image tag to roll back to (default: the release before the current one in releases.log)
  --force            roll back even if the target release does not know the current schema revision
  --skip-smoke       do not run the smoke test afterwards
EOF
}

ROLLBACK=0
TO=""
FORCE=0
REF=""
ALLOW_DIRTY=0
SKIP_SMOKE=0
PASS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rollback) ROLLBACK=1; shift ;;
    --to) TO=${2:?}; shift 2 ;;
    --force) FORCE=1; shift ;;
    --ref) REF=${2:?}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; PASS+=("$1"); shift ;;
    --env-file) MNEMOS_ENV_FILE=${2:?}; PASS+=("$1" "$2"); shift 2 ;;
    --project) MNEMOS_PROJECT=${2:?}; PASS+=("$1" "$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) PASS+=("$1"); shift ;;
  esac
done

require_docker
require_env_file

# ------------------------------------------------------------------------------------------------ upgrade
if [[ $ROLLBACK -eq 0 ]]; then
  if [[ -n "$REF" ]]; then
    require_cmd git
    if [[ $ALLOW_DIRTY -eq 0 && -n "$(git -C "$MNEMOS_ROOT" status --porcelain --untracked-files=no)" ]]; then
      die "the checkout has uncommitted changes (commit/stash them or pass --allow-dirty)"
    fi
    banner "checking out $REF"
    git -C "$MNEMOS_ROOT" fetch --tags --prune origin
    if git -C "$MNEMOS_ROOT" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      git -C "$MNEMOS_ROOT" checkout "$REF"
      git -C "$MNEMOS_ROOT" pull --ff-only origin "$REF"
    else
      git -C "$MNEMOS_ROOT" checkout --detach "$REF"
    fi
    ok "checked out $(git -C "$MNEMOS_ROOT" describe --tags --always --dirty)"
  fi
  exec "$MNEMOS_ROOT/scripts/deploy.sh" "${PASS[@]}"
fi

# ------------------------------------------------------------------------------------------------ rollback
STATE=$(state_dir)
CURRENT=$(env_get MNEMOS_VERSION latest)
if [[ -z "$TO" ]]; then
  [[ -f "$STATE/releases.log" ]] || die "no release history ($STATE/releases.log); pass --to VERSION"
  TO=$(awk -F'\t' -v cur="$CURRENT" '$2 != cur {v = $2} END {print v}' "$STATE/releases.log")
  [[ -n "$TO" ]] || die "no previous release different from $CURRENT in $STATE/releases.log; pass --to VERSION"
fi
[[ "$TO" != "$CURRENT" ]] || warn "target $TO is already the recorded current version (re-applying it)"

# Resolve image names exactly as compose will (honours MNEMOS_IMAGE_PREFIX and any compose overrides).
CONFIG_JSON=$(MNEMOS_VERSION="$TO" compose config --format json)
API_IMAGE=$(json_get .services.api.image <<<"$CONFIG_JSON")
WEB_IMAGE=$(json_get .services.web.image <<<"$CONFIG_JSON")
[[ -n "$API_IMAGE" && -n "$WEB_IMAGE" ]] || die "could not resolve api/web image names from the compose configuration"
banner "rollback $CURRENT -> $TO"
for img in "$API_IMAGE" "$WEB_IMAGE"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    log "image $img not present locally - pulling"
    docker pull "$img" || die "image $img is not available locally or in the registry"
  fi
done

service_running postgres || die "postgres is not running"
DB_REV=$(psql_live "SELECT string_agg(version_num, ',') FROM alembic_version" | tr -d '[:space:]')
KNOWN=$(docker run --rm --network none --entrypoint python "$API_IMAGE" -c '
from alembic.config import Config
from alembic.script import ScriptDirectory
s = ScriptDirectory.from_config(Config("/app/backend/alembic.ini"))
print(" ".join(r.revision for r in s.walk_revisions()))')
compatible=1
IFS=',' read -r -a revs <<<"$DB_REV"
for r in "${revs[@]}"; do
  [[ " $KNOWN " == *" $r "* ]] || compatible=0
done
if [[ $compatible -eq 1 ]]; then
  ok "schema check: database revision $DB_REV is known to $TO"
elif [[ $FORCE -eq 1 ]]; then
  warn "database revision $DB_REV is NEWER than release $TO; continuing because of --force (expand-only migrations assumed)"
else
  err "database revision $DB_REV is not known to release $TO (a migration was added after it)."
  cat >&2 <<EOF
Options:
  * If that migration was additive (expand phase: new tables/nullable columns/indexes), older code keeps working:
      scripts/upgrade.sh --rollback --to $TO --force
  * Otherwise restore the pre-migration backup taken by deploy.sh (data written since then is lost):
      ls -1t $(backup_dir)/*pre-deploy*.dump | head
      scripts/restore.sh --target live --file <that dump>   # then: scripts/upgrade.sh --rollback --to $TO
EOF
  exit 1
fi

export MNEMOS_VERSION="$TO"
running=(api worker web)
service_running mcp && running+=(mcp)
compose up -d --no-deps --wait --wait-timeout 300 "${running[@]}"
env_set "$MNEMOS_ENV_FILE" MNEMOS_VERSION "$TO"
printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TO" "-" "rollback-from-$CURRENT" >>"$STATE/releases.log"
ok "application rolled back to $TO (MNEMOS_VERSION updated in $MNEMOS_ENV_FILE)"

if [[ $SKIP_SMOKE -eq 0 ]]; then
  "$MNEMOS_ROOT/scripts/smoke-prod.sh" --env-file "$MNEMOS_ENV_FILE" --project "$MNEMOS_PROJECT" \
    --key-file "$STATE/smoke-admin.key"
fi

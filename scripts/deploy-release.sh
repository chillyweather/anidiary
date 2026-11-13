#!/usr/bin/env bash
set -euo pipefail

APP_DIR=$1
RELEASE_DIR=$2
VERIFIED_SHA=$3
DB_PATH=${DB_PATH:-$APP_DIR/anidiary.db}
BACKUP_DIR=$APP_DIR/backups
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_PATH=$BACKUP_DIR/anidiary-$TIMESTAMP-$VERIFIED_SHA.db
HAS_VERIFIED_BACKUP=false

# Tunables (env): SMOKE_ATTEMPTS (30), SMOKE_DELAY_SECONDS (1), KEEP_RELEASES (5),
# KEEP_BACKUPS (10). Invalid values fall back to the defaults.
# Prints $1 if it is a positive integer, otherwise the default $2.
integer_or_default() {
  local value=$1 fallback=$2
  if [[ $value =~ ^[0-9]{1,6}$ ]] && [ "$((10#$value))" -ge 1 ]; then
    printf '%s' "$((10#$value))"
  else
    printf '%s' "$fallback"
  fi
}

SMOKE_ATTEMPTS=$(integer_or_default "${SMOKE_ATTEMPTS:-}" 30)
if ! [[ ${SMOKE_DELAY_SECONDS:-} =~ ^[0-9]{1,4}([.][0-9]+)?$ ]]; then
  SMOKE_DELAY_SECONDS=1
fi
KEEP_RELEASES=$(integer_or_default "${KEEP_RELEASES:-}" 5)
KEEP_BACKUPS=$(integer_or_default "${KEEP_BACKUPS:-}" 10)

mkdir -p "$BACKUP_DIR"
cd "$RELEASE_DIR"

# All preparation completes before PM2 is asked to replace the running process.
npm ci --omit=dev
if [ -f "$APP_DIR/.env" ]; then
  ln -sfn "$APP_DIR/.env" "$RELEASE_DIR/.env"
fi

if [ -f "$DB_PATH" ]; then
  command -v sqlite3 >/dev/null
  sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"
  INTEGRITY=$(sqlite3 "$BACKUP_PATH" 'PRAGMA integrity_check;')
  if [ "$INTEGRITY" != "ok" ]; then
    echo "Backup integrity check failed: $INTEGRITY"
    exit 1
  fi
  HAS_VERIFIED_BACKUP=true
  echo "Verified database backup: $BACKUP_PATH"
else
  echo "No existing database; migration will create $DB_PATH"
fi

DB_PATH="$DB_PATH" NODE_ENV=production node scripts/migrate.js
command -v pm2 >/dev/null

PREVIOUS_RELEASE=$(cat "$APP_DIR/.current-release" 2>/dev/null || printf '%s' "$APP_DIR")
export DB_PATH
pm2 delete anidiary || true
pm2 start "$RELEASE_DIR/ecosystem.config.js" --env production --update-env

# /healthz returns {"ok":true} only when the running code can write the database
# and its schema version matches the code, so a stale or read-only deploy fails here.
SMOKE_URL="http://127.0.0.1:${PORT:-3000}/healthz"
SMOKE_OK=false
for attempt in $(seq 1 "$SMOKE_ATTEMPTS"); do
  if curl -fsS --max-time 5 "$SMOKE_URL" 2>/dev/null | grep -q '"ok":true'; then
    SMOKE_OK=true
    echo "Smoke check passed on attempt $attempt"
    break
  fi
  if [ "$attempt" -lt "$SMOKE_ATTEMPTS" ]; then
    sleep "$SMOKE_DELAY_SECONDS"
  fi
done

if [ "$SMOKE_OK" != true ]; then
  echo "Smoke check failed for $VERIFIED_SHA after $SMOKE_ATTEMPTS attempts"
  if [ "$HAS_VERIFIED_BACKUP" = true ]; then
    sqlite3 "$DB_PATH" ".restore '$BACKUP_PATH'"
    RESTORED_INTEGRITY=$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')
    if [ "$RESTORED_INTEGRITY" != "ok" ]; then
      echo "Restored database integrity check failed: $RESTORED_INTEGRITY"
      exit 1
    fi
    echo "Restored database backup: $BACKUP_PATH"
  fi
  if [ -f "$PREVIOUS_RELEASE/ecosystem.config.js" ]; then
    pm2 delete anidiary || true
    pm2 start "$PREVIOUS_RELEASE/ecosystem.config.js" --env production --update-env || true
    # Without this, a PM2 resurrection would start whatever was saved last.
    pm2 save || true
  fi
  exit 1
fi

# Saved only now, so a rejected release is never what PM2 resurrects.
pm2 save

printf '%s\n' "$PREVIOUS_RELEASE" > "$APP_DIR/.previous-release"
printf '%s\n' "$RELEASE_DIR" > "$APP_DIR/.current-release"
echo "Released verified revision $VERIFIED_SHA with backup $BACKUP_PATH"

# Retention runs only after a successful release, and a failure here never fails
# the deploy. It deletes only direct children of releases/ named by a full commit
# SHA and backups/anidiary-*.db files, newest (by mtime) first kept, and never
# the current release, the recorded previous release, or this run's backup.
# The functions run in an `||` context where `set -e` is suspended, so every
# step checks its own status.
prune_oldest() {
  local directory=$1 type=$2 pattern=$3 name_regex=$4 keep=$5
  shift 5
  local listing entries entry name kept=0 failed=0 protected candidate
  [ -d "$directory" ] || return 0
  listing=$(mktemp) || return 1
  if ! find "$directory" -mindepth 1 -maxdepth 1 -type "$type" -name "$pattern" -printf '%T@ %f\0' > "$listing"; then
    rm -f -- "$listing"
    return 1
  fi
  if ! mapfile -d '' entries < <(sort -z -rn -- "$listing"); then
    rm -f -- "$listing"
    return 1
  fi
  rm -f -- "$listing"

  for entry in "${entries[@]+"${entries[@]}"}"; do
    name=${entry#* }
    [[ $name =~ $name_regex ]] || continue
    protected=false
    for candidate in "$@"; do
      if [ -n "$candidate" ] && [ "$name" = "$candidate" ]; then
        protected=true
      fi
    done
    if [ "$kept" -lt "$keep" ]; then
      kept=$((kept + 1))
      continue
    fi
    if [ "$protected" = true ]; then
      continue
    fi
    if rm -rf -- "${directory:?}/$name"; then
      echo "Pruned $directory/$name"
    else
      echo "Could not prune $directory/$name"
      failed=1
    fi
  done
  return "$failed"
}

# Prints the release directory name a recorded release path points at, if any.
# The path is resolved first, so a symlink to a release protects its target;
# a recorded path that cannot be resolved stops pruning rather than guessing.
release_name() {
  local resolved
  resolved=$(realpath -e -- "$1") || return 1
  [ "$(dirname -- "$resolved")" -ef "$APP_DIR/releases" ] || return 0
  basename -- "$resolved"
}

prune_old_releases() {
  local current previous
  # Mark the just-released directory newest so a redeploy of an old SHA is kept.
  touch -- "$RELEASE_DIR" || return 1
  current=$(release_name "$(cat "$APP_DIR/.current-release")") || return 1
  previous=$(release_name "$(cat "$APP_DIR/.previous-release")") || return 1
  if [ -z "$current" ]; then
    echo "Current release is outside $APP_DIR/releases; skipping release pruning"
  else
    prune_oldest "$APP_DIR/releases" d '*' '^[0-9a-f]{40}$' "$KEEP_RELEASES" \
      "$current" "$previous" || return 1
  fi
  local this_backup=
  if [ "$HAS_VERIFIED_BACKUP" = true ]; then
    this_backup=$(basename -- "$BACKUP_PATH")
  fi
  prune_oldest "$BACKUP_DIR" f 'anidiary-*.db' '^anidiary-.*[.]db$' "$KEEP_BACKUPS" "$this_backup"
}

if ! prune_old_releases; then
  echo "Warning: pruning old releases or backups failed; the release itself succeeded"
fi

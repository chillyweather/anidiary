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
pm2 save

# /healthz returns {"ok":true} only when the running code can write the database
# and its schema version matches the code, so a stale or read-only deploy fails here.
SMOKE_URL="http://127.0.0.1:${PORT:-3000}/healthz"
SMOKE_OK=false
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 "$SMOKE_URL" 2>/dev/null | grep -q '"ok":true'; then
    SMOKE_OK=true
    echo "Smoke check passed on attempt $attempt"
    break
  fi
  sleep 1
done

if [ "$SMOKE_OK" != true ]; then
  echo "Smoke check failed for $VERIFIED_SHA after 30 attempts"
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
  fi
  exit 1
fi

printf '%s\n' "$PREVIOUS_RELEASE" > "$APP_DIR/.previous-release"
printf '%s\n' "$RELEASE_DIR" > "$APP_DIR/.current-release"
echo "Released verified revision $VERIFIED_SHA with backup $BACKUP_PATH"

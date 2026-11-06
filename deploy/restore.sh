#!/usr/bin/env sh
# Restore into the running stack (use a STAGING stack first!).
# Usage: deploy/restore.sh backups/db-YYYYmmdd-HHMMSS.dump [backups/media-YYYYmmdd-HHMMSS.tgz]
set -eu
DUMP="$1"; MEDIA="${2:-}"
C="${COMPOSE:-docker compose -f deploy/docker-compose.yml --env-file deploy/.env}"
$C stop api worker bot 2>/dev/null || $C stop api worker
$C exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
$C exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < "$DUMP"
if [ -n "$MEDIA" ]; then
  $C run --rm --no-deps --user root -v "$(cd "$(dirname "$MEDIA")" && pwd)":/backup api sh -c "rm -rf /app/var/storage/* && tar xzf /backup/$(basename "$MEDIA") -C /app/var"
fi
# a dump from an older release is brought up to the current schema
$C run --rm migrate
$C up -d api worker
echo "restored"

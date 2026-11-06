#!/usr/bin/env sh
# Daily backup: PostgreSQL custom-format dump + media volume archive.
# Usage: deploy/backup.sh [backup_dir]   (run from repo root; cron example in docs/BACKUP.md)
set -eu
DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$DIR"
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DIR/db-$STAMP.dump"
$C run --rm --no-deps --user root -v "$(cd "$DIR" && pwd)":/backup api sh -c "tar czf /backup/media-$STAMP.tgz -C /app/var storage"
echo "ok: $DIR/db-$STAMP.dump $DIR/media-$STAMP.tgz"

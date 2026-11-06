#!/usr/bin/env sh
# Base backup for point-in-time recovery + WAL archive pruning.
# Usage (repo root): deploy/basebackup.sh [keep_days]   — cron example in docs/BACKUP.md
# Keeps base backups for keep_days (default 7) and removes archived WAL older than the
# oldest kept base backup, so the archive never grows without bound.
set -eu
KEEP="${1:-7}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
C="${COMPOSE:-docker compose -f deploy/docker-compose.yml --env-file deploy/.env}"
$C exec -T -u postgres db sh -ec "
  mkdir -p /wal/base
  pg_basebackup -U \"\$POSTGRES_USER\" -D /wal/base/$STAMP -Ft -z -X none -c fast -l hikoya-$STAMP
  find /wal/base -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP -exec rm -rf {} +
  OLDEST=\$(ls -1 /wal/base | sort | head -n1)
  [ -n \"\$OLDEST\" ] || exit 0
  START=\$(zcat /wal/base/\$OLDEST/base.tar.gz | tar -xOf - backup_label 2>/dev/null | sed -n 's/^START WAL LOCATION: .* (file \\(.*\\))\$/\\1/p')
  [ -n \"\$START\" ] && pg_archivecleanup -x .gz /wal \"\$START\" || true
"
echo "ok: base backup $STAMP (walarchive volume, /wal/base/$STAMP)"

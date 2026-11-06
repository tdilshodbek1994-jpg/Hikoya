#!/usr/bin/env sh
# Point-in-time restore from the walarchive volume (base backup + archived WAL).
# Usage (repo root): deploy/pitr-restore.sh BASE_STAMP ["YYYY-MM-DD HH:MM:SS+05"]
#   BASE_STAMP  directory name under /wal/base (deploy/basebackup.sh prints it)
#   target time optional; without it the database is replayed to the last archived WAL.
# DESTRUCTIVE: replaces the current database files. api/worker/bot are stopped first.
set -eu
BASE="${1:?base backup stamp, e.g. 20261106-192908}"
TARGET="${2:-}"
C="${COMPOSE:-docker compose -f deploy/docker-compose.yml --env-file deploy/.env}"
printf 'Joriy baza %s nusxasidan tiklanadi%s. Davom etish uchun HA deb yozing: ' "$BASE" "${TARGET:+ ($TARGET holatiga)}"
read -r ok
[ "$ok" = "HA" ] || { echo "bekor qilindi"; exit 1; }
$C stop api worker bot 2>/dev/null || true
$C stop db
$C run --rm --no-deps --user root --entrypoint sh db -ec "
  test -f /wal/base/$BASE/base.tar.gz
  D=/var/lib/postgresql/data
  mkdir -p /wal/pre-restore && tar czf /wal/pre-restore/data-\$(date -u +%Y%m%d-%H%M%S).tgz -C \$D . 2>/dev/null || true
  find \$D -mindepth 1 -delete
  tar xzf /wal/base/$BASE/base.tar.gz -C \$D
  cat >> \$D/postgresql.auto.conf <<CONF
restore_command = 'gunzip -c /wal/%f.gz > %p'
recovery_target_action = 'promote'
CONF
  [ -z '$TARGET' ] || echo \"recovery_target_time = '$TARGET'\" >> \$D/postgresql.auto.conf
  touch \$D/recovery.signal
  chown -R postgres:postgres \$D && chmod 700 \$D
"
$C up -d db
echo "db qayta tiklanmoqda; holat: $C logs -f db   (\"database system is ready\" chiqqach: $C up -d)"

#!/usr/bin/env sh
# Server move, step 1 (OLD server, repo root): one archive with the database, media and deploy/.env.
# Usage: [STOP=1] deploy/migrate-export.sh [out_dir]   (STOP=1 stops api/worker/bot first: no lost writes)
# The archive contains SECRETS (bot token, passwords): copy it only over scp/ssh, delete it afterwards.
set -eu
OUT="${1:-/root}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
C="${COMPOSE:-docker compose -f deploy/docker-compose.yml --env-file deploy/.env}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ "${STOP:-}" = 1 ]; then
  # freeze writes: from here on readers see the site as unavailable until the new server is live
  $C stop api worker bot 2>/dev/null || $C stop api worker
fi
echo "1/3 baza va media nusxasi..."
COMPOSE="$C" sh deploy/backup.sh "$TMP" >/dev/null
mv "$TMP"/db-*.dump "$TMP/db.dump"
mv "$TMP"/media-*.tgz "$TMP/media.tgz"
echo "2/3 sozlamalar (.env)..."
cp "${ENV_FILE:-deploy/.env}" "$TMP/env"
git rev-parse HEAD > "$TMP/commit" 2>/dev/null || true
echo "3/3 arxiv..."
mkdir -p "$OUT"
tar czf "$OUT/hikoya-move-$STAMP.tgz" -C "$TMP" .
chmod 600 "$OUT/hikoya-move-$STAMP.tgz"
ls -lh "$OUT/hikoya-move-$STAMP.tgz"
echo "Tayyor. Yangi serverga: scp $OUT/hikoya-move-$STAMP.tgz root@YANGI_IP:/root/"

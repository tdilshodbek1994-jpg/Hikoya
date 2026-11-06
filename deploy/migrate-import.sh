#!/usr/bin/env sh
# Server move, step 2 (NEW server, inside a fresh clone of the repo):
#   sh deploy/migrate-import.sh /root/hikoya-move-YYYYmmdd-HHMMSS.tgz
# Restores .env, database and media, applies migrations and starts the stack.
set -eu
ARCH="${1:?arxiv yo'li kerak: /root/hikoya-move-....tgz}"
C="${COMPOSE:-docker compose -f deploy/docker-compose.yml --env-file deploy/.env}"
[ -f "$ARCH" ] || { echo "arxiv topilmadi: $ARCH"; exit 1; }
if [ -f deploy/.env ]; then
  printf 'deploy/.env allaqachon bor. Arxivdagisi bilan almashtirilsinmi? (HA/yo'\''q): '
  read -r ok; [ "$ok" = "HA" ] || { echo "bekor qilindi"; exit 1; }
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar xzf "$ARCH" -C "$TMP"
cp "$TMP/env" deploy/.env && chmod 600 deploy/.env
echo "1/4 image'lar build qilinmoqda (bir necha daqiqa)..."
[ "${SKIP_BUILD:-}" = 1 ] || $C build
echo "2/4 baza ishga tushirilmoqda..."
$C up -d db
i=0; until $C exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "baza ishga tushmadi"; exit 1; }; sleep 2; done
echo "3/4 ma'lumotlar tiklanmoqda..."
COMPOSE="$C" sh deploy/restore.sh "$TMP/db.dump" "$TMP/media.tgz"
echo "4/4 hammasi ishga tushirilmoqda..."
$C up -d ${UP_SERVICES:-}
$C ps
echo
echo "Keyingi qadamlar (docs/MIGRATE.md):"
echo "  1) DNS: domen A yozuvini shu server IP'siga o'zgartiring"
echo "  2) HTTPS: nginx/certbot yoki --profile https"
echo "  3) make bot-setup   (webhook yangi serverga)"

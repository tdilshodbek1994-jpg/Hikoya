#!/bin/bash
# Sado'ni serverda yangilash: bash /opt/sado-speaking/deploy/update-sado.sh
cd /opt/sado-speaking || exit 1
git fetch -q origin && git reset -q --hard origin/ccr-b21c2185-xe8igr
npm install --omit=dev --silent
git checkout -- package-lock.json 2>/dev/null
mkdir -p data && chown -R www-data:www-data data   # progress shu yerda saqlanadi
grep -q "^SHARE_URL=" .env || echo "SHARE_URL=https://t.me/Uzdtm_bot" >> .env   # natijani ulashish havolasi
systemctl restart sado-speaking
sleep 3
echo "holat: $(systemctl is-active sado-speaking)"
echo "mavzular: $(curl -s localhost:3000/api/lessons | grep -o '"id"' | wc -l)"
echo "progress API: $(curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/progress) (401 bo'lishi kerak - bu to'g'ri)"

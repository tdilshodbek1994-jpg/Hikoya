#!/bin/bash
# UzDTM ichidagi Gapchi o'rniga Sado'ni ulaydi. Xato bo'lsa hammasi avvalgi holiga qaytadi.
set -u
W=/opt/dtm-markazi/web
rm -f "$W/src/pages/Speaking.t"
[ -f /opt/dtm-markazi/Speaking.gapchi.bak ] || cp "$W/src/pages/Speaking.tsx" /opt/dtm-markazi/Speaking.gapchi.bak
cp /opt/sado-speaking/deploy/dtm-Speaking.tsx "$W/src/pages/Speaking.tsx"
cd /opt/dtm-markazi
SVC=$(docker inspect dtm-markazi-web-1 --format '{{index .Config.Labels "com.docker.compose.service"}}')
if docker compose up -d --build "$SVC" >/tmp/dtm-build.log 2>&1; then
  echo "TAYYOR ✅ Gapchi o'rniga Sado ulandi"
else
  cp /opt/dtm-markazi/Speaking.gapchi.bak "$W/src/pages/Speaking.tsx"
  echo "XATO - Gapchi qaytarildi. Sabab:"
  tail -n 8 /tmp/dtm-build.log
fi

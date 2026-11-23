#!/bin/bash
# 📞 Jonli suhbat uchun nginx sozlamasi: faqat Sado'ning "location /speaking/" blokiga
# WebSocket qatorlari va uzun kutish vaqtini qo'shadi. Boshqa joylarga (UzDTM) tegmaydi.
#   bash /opt/sado-speaking/deploy/fix-nginx.sh
# Avval nusxa oladi; "nginx -t" xato bersa — nusxani qaytaradi va nginx qayta yuklanmaydi.
set -u
CONF_DIR="${NGINX_DIR:-/etc/nginx}"

BAK_DIR="${SADO_BAK_DIR:-/root/sado-nginx-backup}"   # nusxalar nginx papkasidan TASHQARIDA (nginx ularni o'qimasin)
mkdir -p "$BAK_DIR"
FILES=$(grep -rlE 'location[[:space:]]+/speaking/' "$CONF_DIR" 2>/dev/null | grep -v '\.bak' | xargs -r -n1 readlink -f | sort -u)
if [ -z "$FILES" ]; then
  echo "❌ nginx sozlamasida 'location /speaking/' topilmadi ($CONF_DIR)."
  exit 1
fi

for F in $FILES; do
  echo "📄 Fayl: $F"
  BAK="$BAK_DIR/$(echo "$F" | tr '/' '_').$(date +%Y%m%d%H%M%S)"
  cp -p "$F" "$BAK" || { echo "❌ Nusxa olib bo'lmadi"; exit 1; }
  echo "   💾 Nusxa: $BAK"
  python3 - "$F" <<'PY'
import re, sys
p = sys.argv[1]
lines = open(p).read().split("\n")
out, i, changed = [], 0, 0
NEW = ['proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection "upgrade";',
       'proxy_read_timeout 900s;', 'proxy_send_timeout 900s;']
DROP = re.compile(r'^\s*(proxy_set_header\s+(Upgrade|Connection)\b|proxy_read_timeout\b|proxy_send_timeout\b)')
while i < len(lines):
    ln = lines[i]
    out.append(ln)
    if re.match(r'^\s*location\s+/speaking/\s*\{', ln):
        indent = re.match(r'^(\s*)', ln).group(1) + "    "
        out += [indent + "# 📞 Sado jonli suhbat (WebSocket)"] + [indent + x for x in NEW]
        depth = ln.count("{") - ln.count("}")
        i += 1
        while i < len(lines) and depth > 0:
            b = lines[i]
            depth += b.count("{") - b.count("}")
            if depth > 0 and (DROP.match(b) or b.strip() == "# 📞 Sado jonli suhbat (WebSocket)"):
                i += 1
                continue  # eskisini olib tashlaymiz — yangisi yuqorida
            out.append(b)
            i += 1
        changed += 1
        continue
    i += 1
open(p, "w").write("\n".join(out))
print(f"   ✏️ {changed} ta blok yangilandi")
PY
done

if nginx -t 2>&1; then
  systemctl reload nginx && echo "✅ nginx yangilandi. Jonli suhbat uchun sozlama tayyor."
else
  echo "❌ nginx -t xato berdi — eski holatga qaytarilmoqda"
  for F in $FILES; do
    B=$(ls -t "$BAK_DIR/$(echo "$F" | tr '/' '_')".* 2>/dev/null | head -1)
    [ -n "$B" ] && cp -p "$B" "$F" && echo "   ↩️ $F qaytarildi"
  done
  exit 1
fi

#!/bin/bash
# Sado'ni serverda yangilash: bash /opt/sado-speaking/deploy/update-sado.sh
cd /opt/sado-speaking || exit 1
git fetch -q origin && git reset -q --hard origin/ccr-b21c2185-xe8igr
npm install --omit=dev --silent
git checkout -- package-lock.json 2>/dev/null
mkdir -p data && chown -R www-data:www-data data   # progress shu yerda saqlanadi
grep -q "^ADMIN_KEY=" .env || echo "ADMIN_KEY=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env   # statistika sahifasi kaliti
grep -q "^SHARE_URL=" .env || echo "SHARE_URL=https://t.me/Uzdtm_bot" >> .env   # natijani ulashish havolasi
systemctl restart sado-speaking
sleep 3
echo "holat: $(systemctl is-active sado-speaking)"
echo "versiya: $(git log -1 --format='%h %cd' --date=format:'%d.%m %H:%M') · ilova v$(grep -o 'app.js?v=[0-9]*' public/index.html | cut -d= -f2)  (Sado ⚙️ Sozlamalar pastida ham shu ko'rinadi)"
if grep -q '^FREE_ONLY=0' .env; then echo "mavzular: $(curl -s localhost:3000/api/lessons | grep -o '"id"' | wc -l)"; else echo "rejim: 💬 faqat Erkin suhbat (darslar yashirin; qaytarish: FREE_ONLY=0)"; fi
echo "AI model: $(grep '^CLAUDE_MODEL=' .env | cut -d= -f2 | grep . || echo 'claude-haiku-5-5 (standart, eng tez)')"
# 🔊 O'zbekcha ovoz (Azure) tekshiruvi — kalit ekranga chiqmaydi
AZK=$(grep '^AZURE_SPEECH_KEY=' .env | cut -d= -f2); AZR=$(grep '^AZURE_SPEECH_REGION=' .env | cut -d= -f2)
if [ -n "$AZK" ] && [ -n "$AZR" ]; then
  AZC=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -X POST "https://$AZR.tts.speech.microsoft.com/cognitiveservices/v1" -H "Ocp-Apim-Subscription-Key: $AZK" -H "Content-Type: application/ssml+xml" -H "X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3" -H "User-Agent: sado" -d '<speak version="1.0" xml:lang="uz-UZ"><voice name="uz-UZ-MadinaNeural">Salom</voice></speak>')
  [ "$AZC" = "200" ] && echo "o'zbekcha ovoz (Azure): ✅ ishlayapti" || echo "o'zbekcha ovoz (Azure): ⚠️ javob $AZC — kalit yoki obunani tekshiring (portal.azure.com)"
else
  echo "o'zbekcha ovoz (Azure): ⚠️ sozlanmagan — OpenAI ovozi ishlatiladi"
fi
echo "progress API: $(curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/progress) (401 bo'lishi kerak - bu to'g'ri)"
echo "statistika: https://testmarkaz.online/speaking/admin.html?key=$(grep '^ADMIN_KEY=' .env | cut -d= -f2)"
# 📞 Jonli suhbat uchun nginx tekshiruvi (faqat o'qiydi, hech narsani o'zgartirmaydi)
NGX=$(grep -rlE 'location[[:space:]]+/speaking/' /etc/nginx 2>/dev/null | grep -v '\.bak' | head -1)
if [ -n "$NGX" ] && awk '/location[[:space:]]+\/speaking\//,/}/' "$NGX" | grep -q 'Upgrade'; then
  echo "nginx (jonli suhbat): ✅ tayyor"
elif [ -n "$NGX" ]; then
  echo "nginx (jonli suhbat): ⚠️ sozlanmagan — bir marta ishga tushiring:  bash /opt/sado-speaking/deploy/fix-nginx.sh"
fi
# 🧹 Telefonlarda eski versiya: Sado'ni ikki marta oching (birinchisida kesh tozalanadi)

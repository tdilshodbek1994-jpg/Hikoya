# Bot Timeweb'da ishlashi uchun: Telegram'ga ulanish

**Muammo.** Mini App ishlaydi, chunki foydalanuvchi telefoni serverga kiradi. Bot javob bermaydi, chunki serverning o'zi `api.telegram.org` ga chiqa olmaydi (so'rov timeout bo'ladi). Ma'lumot va sayt Timeweb'da qoladi, faqat botning Telegram'ga yuboradigan so'rovlariga yo'l kerak.

## 1-qadam: sababni aniqlash (1 daqiqa)

```bash
cd /srv/Hikoya && git pull && make up
make bot-check
```

Natijaga qarab:

| `make bot-check` xulosasi | Nima qilish kerak |
|---|---|
| «Bot API ishlayapti» | `make bot-setup`. Muammo hal bo'lgan |
| «IPv4 ishlaydi, IPv6 yo'q» | `.env` ga `HIKOYA_TELEGRAM_FORCE_IPV4=true` → `make up` → `make bot-check` |
| «api.telegram.org bu serverdan yopiq» | 2-qadam (Cloudflare relay). Bepul va Timeweb'da qolasiz |
| «umuman tashqi internet yo'q» | Timeweb panelida firewall/DNS sozlamasini tekshiring |

## 2-qadam: Cloudflare Worker relay (bepul, telefondan qilsa bo'ladi)

Relay — Cloudflare'dagi kichik dastur. U server so'rovini `api.telegram.org` ga uzatadi. Faqat **sizning botingiz** so'rovlarini o'tkazadi, boshqa hammasiga 404 qaytaradi.

1. https://dash.cloudflare.com → ro'yxatdan o'ting (bepul).
2. **Workers & Pages → Create → Create Worker** → nom: `hikoya-tg` → **Deploy**.
3. **Edit code** → hamma kodni o'chiring → repozitoriydagi `deploy/telegram-relay/worker.js` matnini qo'ying → **Deploy**.
   Telefondan matnni olish: GitHub'da `deploy/telegram-relay/worker.js` → **Raw** → hammasini nusxalash.
4. **Settings → Variables and Secrets → Add**:
   - nom `ALLOWED_BOT_ID`;
   - qiymat — bot tokenidagi `:` belgisidan **oldingi raqam**, masalan token `9018xxxxxx:AA...` bo'lsa `9018xxxxxx`. Bu raqam sir emas; tokenning `:` dan keyingi qismini hech qayerga yozmang.
   - **Deploy**.
5. Worker manzili: `https://hikoya-tg.<akkaunt>.workers.dev`.

Serverda:

```bash
curl -s https://hikoya-tg.<akkaunt>.workers.dev/      # "not found" chiqsa — relay serverdan ko'rinadi
nano deploy/.env
#   HIKOYA_TELEGRAM_API_BASE=https://hikoya-tg.<akkaunt>.workers.dev
#   HIKOYA_TELEGRAM_PROXY=                 (bo'sh)
make up
make bot-check                                         # getMe: OK @UzbHikoyabot
```

## 3-qadam: webhook yoki polling

Telegram serveringizga HTTPS orqali kira oladi (`https://shamsinur.fit` ishlayapti), shuning uchun **webhook** tavsiya etiladi:

```bash
nano deploy/.env          # HIKOYA_WEBHOOK_SECRET=<openssl rand -hex 32 natijasi>
                          # COMPOSE_PROFILES qatorida "polling" bo'lsa — olib tashlang
make up
make bot-setup            # webhook, buyruqlar, menyu tugmasi: hammasi OK bo'lishi kerak
```

So'ng botda `/start` bosing.

Polling ham ishlaydi (`HIKOYA_WEBHOOK_SECRET=` bo'sh, `COMPOSE_PROFILES=polling`), lekin webhook tezroq va Cloudflare limitini kam sarflaydi.

## Cheklovlar
- Cloudflare bepul rejasi: kuniga 100 000 so'rov. Bu bir necha ming faol o'quvchiga yetadi. Bildirishnomalar ko'payganda Workers Paid ($5/oy) yoki 4-variant.
- `workers.dev` domeni ba'zan sekinlashishi mumkin. Unda Worker'ga Cloudflare'dagi o'z domeningizni ulang (Settings → Domains & Routes) va `HIKOYA_TELEGRAM_API_BASE` ni o'shanga almashtiring.

## Boshqa variantlar
- **Proksi** (SOCKS5/HTTP, masalan Vultr'dagi): `HIKOYA_TELEGRAM_PROXY=socks5://user:pass@IP:1080`.
- **Timeweb Cloud'ning xorijiy lokatsiyasi.** Timeweb panelida server yaratishda lokatsiyalar ro'yxatini ko'ring. Telegram ochiq bo'lgan lokatsiyada yangi server yarating va [MIGRATE.md](MIGRATE.md) bo'yicha ko'chiring. Bunda Timeweb'da qolasiz va relay kerak bo'lmaydi.

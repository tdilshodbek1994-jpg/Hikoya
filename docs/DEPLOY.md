# Deploy: server, BotFather, Mini App va to'lovlar

Bu yo'riqnoma Docker o'rnatilgan Linux server va sizning domeningiz (masalan `hikoya.example.uz`) uchun yozilgan. Telegram Mini App va webhook faqat **HTTPS** orqali ishlaydi.

## 1. Bot yaratish (BotFather)

1. Telegram'da @BotFather → `/newbot` → nom va username. Tokenni hech kimga bermang.
2. `/newapp` → botni tanlang → nom, tavsif, 640×360 rasm → **Web App URL**: `https://<domen>/` → **short name**: masalan `app`.
   Natijada havola: `https://t.me/<bot_username>/app`.
3. `/mybots` → bot → **Bot Settings → Menu Button** → URL: `https://<domen>/`. (Buni `make bot-setup` ham avtomatik o'rnatadi.)
4. To'lovlar: Telegram Stars (XTR) uchun alohida to'lov provayderi **kerak emas**. Raqamli kontent uchun faqat Stars ishlatiladi.

## 2. Server

```bash
git clone https://github.com/tdilshodbek1994-jpg/Hikoya.git && cd Hikoya
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Majburiy qiymatlar:

| O'zgaruvchi | Izoh |
|---|---|
| `POSTGRES_PASSWORD` | kuchli parol |
| `DOMAIN`, `HIKOYA_PUBLIC_BASE_URL`, `HIKOYA_WEBAPP_URL`, `HIKOYA_CORS_ORIGINS` | sizning domeningiz (`https://...`) |
| `HIKOYA_BOT_TOKEN`, `HIKOYA_BOT_USERNAME`, `HIKOYA_MINIAPP_SHORT_NAME` | BotFather'dan |
| `HIKOYA_WEBHOOK_SECRET` | tasodifiy satr: `openssl rand -hex 32` |
| `HIKOYA_SIGNING_KEY` | tasodifiy satr: `openssl rand -hex 32` |
| `HIKOYA_OWNER_TELEGRAM_IDS` | egasining Telegram **raqamli ID**si, masalan `[123456789]` (username emas) |
| `HIKOYA_TELEGRAM_ENABLED` | `true` |
| `HIKOYA_BILLING_ENABLED` | real narx belgilanmaguncha `false` |

O'z Telegram ID'ingizni bilish uchun @userinfobot kabi botdan foydalanishingiz mumkin.

### HTTPS bilan ishga tushirish

Agar serverda 80/443 portlari bo'sh bo'lsa, ichki Caddy avtomatik sertifikat oladi:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile https up -d --build
```

Agar serverda nginx yoki boshqa reverse proxy allaqachon bo'lsa, `make up` qiling va proxy'dan `http://127.0.0.1:${WEB_PORT}` (standart 8080) manziliga yo'naltiring.

### Birinchi sozlash

```bash
make bot-setup     # buyruqlar, menyu tugmasi va webhook: https://<domen>/api/v1/telegram/webhook
```

So'ng botni oching va `/start` bosing. Egasining `/admin` paneli ochiladi.

Webhook o'rniga long-polling kerak bo'lsa (masalan, domen hali tayyor bo'lmasa): `HIKOYA_WEBHOOK_SECRET` ni bo'sh qoldiring va `--profile polling` bilan ishga tushiring.

## 3. Xodimlar va mualliflar

- Foydalanuvchi avval botni ochishi kerak.
- So'ng egasi botda `/grant <telegram_id> <rol>` buyrug'ini beradi. Rollar: `content_admin`, `editor`, `moderator`, `author`, `support`.
- Shu ishni Mini App → Profil → Boshqaruv → «Xodimlar va vakolatlar» bo'limidan ham qilish mumkin.
- Muallifga «ishonchli» belgisi berilsa, u o'z storisi va asarini tekshiruvsiz nashr qila oladi. Bu Admin → Mualliflar bo'limida qilinadi.

## 4. Premium va real to'lovlar

1. Narx belgilang. Botda `/admin` → «Premium va to'lovlar» → `/price <mahsulot_id> <stars>` (masalan `/price 1 150`).
   Har yangi narx alohida versiya bo'ladi; eski buyurtmalar o'z shartida qoladi.
2. `deploy/.env` faylida `HIKOYA_BILLING_ENABLED=true` qilib, `make up` bilan qayta ishga tushiring.
3. Demo narx (`is_demo`) hech qachon real to'lovga aylanmaydi.
4. 90 va 365 kunlik paketlar bir martalik bo'ladi, avtomatik yangilanmaydi. Ular narx belgilangach ochiladi.
5. Alohida asarni sotish: Admin → «Premium va to'lovlar» → «Alohida asarni sotish» (asar ID + Stars). Asarning kirish siyosati `PURCHASE` yoki `PREMIUM_OR_PURCHASE` bo'lishi kerak.

### To'lovlarni sinash (test muhiti)

Telegram'ning alohida **test muhiti** bor (`https://core.telegram.org/bots/webapps#testing-mini-apps`). Test hisob bilan test muhitidagi @BotFather'da alohida test bot yarating va `deploy/.env` faylida `HIKOYA_TELEGRAM_TEST_ENV=true` qiling: so'rovlar `/bot<token>/test/<method>` yo'liga boradi. Test muhitida Stars to'lovlari haqiqiy pul yechmaydi. Test va real bot uchun alohida baza ishlating. Real botda sinashdan oldin:
- `HIKOYA_TEST_TELEGRAM_IDS` ga test hisoblarni qo'shing, shunda ular TOP va statistikaga kirmaydi;
- to'lovdan keyin «Premium» sahifasi «Tasdiqlanmoqda» → «Premium faol» holatiga o'tishini tekshiring;
- `/admin` → «Premium va to'lovlar» bo'limida to'lov va refund holatlarini kuzating.

## 5. Kundalik ishlar

```bash
make logs      # api va worker loglari
make backup    # backup (docs/BACKUP.md)
make demo-remove   # demo kontentni olib tashlash
```

Boshqa serverga ko'chirish: [MIGRATE.md](MIGRATE.md).

Yangilash: `git pull && make up`. Migratsiyalar `migrate` servisida avtomatik qo'llanadi.

Polling bot ishlatilsa, `deploy/.env` ga `COMPOSE_PROFILES=polling` qo'shing: shunda `make up` bot konteynerini ham yangilaydi.

## 5a. C bosqichi sozlamalari (ixtiyoriy)

Hammasi `deploy/.env` da, keyin `make up`:

| Imkoniyat | Sozlama | Izoh |
|---|---|---|
| WAL arxivi | `WAL_ARCHIVE_TIMEOUT=300` | Standart yoqilgan. Cron: `deploy/basebackup.sh` ([BACKUP.md](BACKUP.md)) |
| Antivirus | `COMPOSE_PROFILES=antivirus` (yoki `polling,antivirus`), `HIKOYA_CLAMAV_HOST=clamav` | ~1.2 GB RAM. `HIKOYA_CLAMAV_REQUIRED=true` bo'lsa skaner ishlamay qolganda yuklash rad etiladi |
| AI yordamchi | `HIKOYA_AI_PROVIDER=anthropic`, `HIKOYA_AI_API_KEY=...` | Kalitni faqat serverdagi `.env` ga yozing. `HIKOYA_AI_DAILY_LIMIT_PER_USER` — kunlik limit. Server `api.anthropic.com` ga chiqa olishi kerak (aks holda `HTTPS_PROXY` kerak bo'ladi) |
| Muallif ulushi | `HIKOYA_ROYALTY_SHARE_PERCENT=70`, `HIKOYA_ROYALTY_HOLD_DAYS=21` | 0 — o'chiq. To'lovlar admin → «Premium va to'lovlar» → «Mualliflar ulushi» |

Iqtibos kartasi, recap, qahramonlar, beta-o'quvchilar, inline izohlar va sovg'a qo'shimcha sozlamasiz ishlaydi.

## 6. Obyekt ombori (ixtiyoriy S3)

Standart holatda fayllar Docker volume'da saqlanadi:
- ochiq muqovalar `public/` ichida, `/media/...` orqali beriladi;
- yopiq originallar `private/` ichida, faqat 60 soniyalik imzolangan havola orqali beriladi.

S3/MinIO/R2 uchun `HIKOYA_STORAGE_BACKEND=s3` qiling va ikki bucket ko'rsating: biri private, biri public.

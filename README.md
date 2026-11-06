# HIKOYA PRO

Telegram Mini App ichida ishlaydigan hikoyalar platformasi va boshqaruv boti. O'quvchi hikoyani topadi, o'qiydi, joyidan davom ettiradi, muallif storisini ko'radi, layk va bepul «rahmat» bildiradi, sharh yozadi va Premium hikoyalarni Telegram Stars orqali ochadi. Mualliflar va administratorlar kontentni bot orqali yoki shu Mini App ichidagi «Ijod ustaxonasi»da boshqaradi.

Loyiha alohida: o'z repozitoriysi, boti, ma'lumotlar bazasi, fayl ombori va konfiguratsiyasi bor. Boshqa loyihalarga (Postbotuzbek, TAQVIM, Online-magazin va boshqalar) bog'lanmagan.

## Tarkib

```
backend/            Python 3.12, FastAPI, SQLAlchemy 2, Alembic (PostgreSQL 16)
  app/api/v1        HTTP API (/api/v1, OpenAPI: docs/openapi.json)
  app/services      biznes qoidalari — API ham, bot ham shu qatlamdan foydalanadi
  app/bot           Telegram bot (webhook va polling uchun bitta dispatcher)
  app/workers       fon worker: rejalashtirilgan nashr, outbox, bildirishnomalar
  app/integrations  Telegram Bot API, obyekt ombori (lokal / S3)
  migrations        Alembic migratsiyalari
  tests             unit va integratsiya testlari (98 ta)
frontend/miniapp    React 19 + TypeScript + Vite, Tiptap muharriri
deploy/             docker-compose, Caddy (HTTPS), .env.example, backup/restore
docs/               yo'riqnomalar, qabul sinovlari, holat, OpenAPI, skrinshotlar
```

## Bitta buyruq bilan ishga tushirish

```bash
cp deploy/.env.example deploy/.env      # qiymatlarni to'ldiring
make up                                  # db + migratsiya + api + worker + web
make demo                                # ixtiyoriy: «demo» belgili original namunaviy kontent
make bot-setup                           # bot buyruqlari, menyu tugmasi, webhook
```

Batafsil:
- [docs/DEPLOY.md](docs/DEPLOY.md) — server, domen, BotFather, Mini App URL, webhook va to'lovlar.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — lokal ishlab chiqish va testlar.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arxitektura, ma'lumot modeli va qarorlar.
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — T-01…T-64 qabul sinovlari holati va dalillari.
- [docs/LOADTEST.md](docs/LOADTEST.md) — yuklama testi (500 o'quvchi).
- [docs/STATUS.md](docs/STATUS.md) — nima tayyor, nima qolgan, cheklovlar va keyingi checkpoint.
- [docs/BACKUP.md](docs/BACKUP.md) — backup, tiklash va avariyadan qaytish.

# Lokal ishlab chiqish

## Talablar
Python 3.12+, Node 22+, PostgreSQL 16 (`pg_trgm` kengaytmasi bilan).

## Backend

```bash
cd backend
uv venv .venv && uv pip install -p .venv/bin/python -r requirements.lock pytest==9.2.0 pytest-asyncio==1.4.1.post1
createdb hikoya && psql -d hikoya -c 'create extension if not exists pg_trgm'
cat > .env <<'EOF'
HIKOYA_DATABASE_URL=postgresql+asyncpg://hikoya:hikoya@localhost:5432/hikoya
HIKOYA_DEV_AUTH_ENABLED=true
HIKOYA_OWNER_TELEGRAM_IDS=[1000]
HIKOYA_BOT_TOKEN=000000:DEV
EOF
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli seed && .venv/bin/python -m app.cli demo
.venv/bin/uvicorn app.main:app --reload --port 8000       # API + /api/docs
.venv/bin/python -m app.workers                           # fon worker
```

`HIKOYA_TELEGRAM_ENABLED=false` (standart) bo'lsa server Telegram'ga hech narsa yubormaydi. Barcha chaqiruvlar soxta javob bilan qaytadi va testlar shu rejimda ishlaydi.

## Testlar

```bash
createdb hikoya_test && psql -d hikoya_test -c 'create extension if not exists pg_trgm'
cd backend && .venv/bin/python -m pytest -q        # 93 ta test
```

## Mini App

```bash
cd frontend/miniapp
npm ci
npm run dev        # http://localhost:5173 (API proxy -> :8000)
npm run build      # typecheck + production build
node e2e/smoke.cjs http://localhost:5173 ./e2e-shots     # 360 px Playwright smoke testi
node e2e/stage_c.cjs http://localhost:5173 ./e2e-shots   # C bosqichi ekranlari (dev auth kerak)
node e2e/stage_d.cjs http://localhost:5173 ./e2e-shots   # tanlovlar, audio sinxron, rus tili
```

Brauzerda Telegram tashqarisida dev kirish oynasi chiqadi. U faqat `HIKOYA_DEV_AUTH_ENABLED=true` bo'lsa ishlaydi, production'da bu rejim yoqilmaydi. `1000` egasi, boshqa raqamlar oddiy o'quvchi.

## Telegram ichida lokal sinash
Mini App HTTPS talab qiladi. Lokal serverni HTTPS tunnel (masalan cloudflared yoki ngrok) bilan oching. So'ng BotFather'da test Mini App URL'ini tunnel manziliga qo'ying va `python -m app.bot polling` ishga tushiring.

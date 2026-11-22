# Sado: ingliz tilida gaplashish mashqi (Telegram Mini App)

DTM botingiz ichida ochiladigan ovozli AI suhbatdosh. O'quvchi vaziyatni (kafe, tanishuv, aeroport va h.k.) tanlaydi, maskot **Sado** bilan ovoz chiqarib inglizcha gaplashadi va har bir darsda 6 ta iborani ishlatishga harakat qiladi.

**Imkoniyatlar**
- 🎙️ Ikki rejim: **Bosmasdan gapirish** (ovozni o'zi aniqlaydi) va **Bosib gapirish**.
- 🤖 Jonli maskot: tinglayotganda yashil, o'ylayotganda sariq, gapirayotganda binafsha rangda bo'ladi. Og'zi ovozga mos harakatlanadi.
- 📋 Ibora kartasi va progress ("6 tadan N ta ibora"), 10 daqiqalik taymer.
- 💬 Subtitrlar: AI javobi, o'zbekcha tarjimasi, siz aytgan gap va qisqa grammatik maslahat.
- ✍️ Mikrofon bo'lmasa, yozib javob berish rejimi.
- 🔒 Har bir so'rov Telegram imzosi (`initData`) orqali tekshiriladi va kunlik limit qo'yilgan.

## Qanday ishlaydi

```
Telegram (DTM bot) ──tugma──► https://domen.uz/speaking/  (Mini App: public/)
                                   │  ovoz (webm/m4a)
                                   ▼
                              server.js (Node.js)
                                ├─ OpenAI  → ovozni matnga aylantirish
                                ├─ Claude  → suhbatdosh javobi + ibora tekshiruvi
                                └─ OpenAI  → javobni ovozga aylantirish
```

## Serverga o'rnatish

Serverda **Node.js 20.12+** bo'lishi kerak (`node -v`).

```bash
# 1. Kodni serverga ko'chiring
sudo git clone https://github.com/tdilshodbek1994-jpg/Hikoya /opt/sado-speaking
cd /opt/sado-speaking
npm install --omit=dev

# 2. Sozlamalar
cp .env.example .env
nano .env        # BOT_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY ni yozing

# 3. Doimiy ishga tushirish (systemd)
sudo cp deploy/sado-speaking.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sado-speaking
sudo systemctl status sado-speaking
```

PM2 ishlatsangiz, systemd o'rniga `pm2 start server.js --name sado-speaking && pm2 save` buyrug'ini bering.

### Nginx (mavjud domeningizga ulash)

`deploy/nginx-speaking.conf` ichidagi `location` bloklarini domeningizning **HTTPS** `server { }` bloki ichiga qo'shing, keyin:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Tekshirish: brauzerda `https://SIZNING-DOMEN.uz/speaking/api/lessons` ochilsa, JSON ko'rinadi.

> Telegram Mini App faqat **HTTPS** bilan ishlaydi.

## DTM botga tugma qo'shish

Botingiz qaysi kutubxonada yozilganiga qarab tayyor kodni oling:

| Bot | Fayl |
|---|---|
| Python, aiogram 3 | `bot/aiogram3.py` |
| Python, pyTelegramBotAPI | `bot/telebot.py` |
| PHP (webhook) | `bot/php.php` |

Har birida `WEBAPP_URL = "https://SIZNING-DOMEN.uz/speaking/"` qatorini o'z domeningizga almashtiring. Oxiridagi `/` belgisi shart.

**Qo'shimcha (kod yozmasdan):** BotFather → `/mybots` → botingiz → **Bot Settings → Menu Button** → URL sifatida `https://SIZNING-DOMEN.uz/speaking/` kiriting. Shunda chat pastidagi menyu tugmasidan ham ochiladi.

> `.env` dagi `BOT_TOKEN` aynan shu DTM botning tokeni bo'lishi kerak. Aks holda imzo tekshiruvi o'tmaydi va "Iltimos, ilovani Telegram bot orqali oching" xabari chiqadi.

## Sozlamalar (`.env`)

| O'zgaruvchi | Vazifasi |
|---|---|
| `BOT_TOKEN` | DTM bot tokeni (majburiy) |
| `ANTHROPIC_API_KEY` | Claude: AI suhbatdosh (majburiy) |
| `OPENAI_API_KEY` | Ovozni tanish va AI ovozi. Bo'lmasa faqat yozma rejim ishlaydi |
| `CLAUDE_MODEL` | Standart: `claude-opus-5-5` |
| `CLAUDE_EFFORT` | `low` (tez javob) / `medium` / `high` |
| `TTS_VOICE` | AI ovozi: `coral`, `alloy`, `nova`, `sage`... |
| `SESSION_MINUTES` | Bitta dars davomiyligi (standart 10) |
| `DAILY_SESSIONS` | Bir foydalanuvchi uchun kunlik darslar soni (standart 10) |
| `ALLOW_DEV` | `1` bo'lsa Telegram'siz brauzerda sinash mumkin. **Serverda 0 qoldiring** |

## Yangi dars qo'shish

`src/lessons.js` fayliga yangi obyekt qo'shing: AI roli, ochilish gapi va 6 ta ibora (inglizcha va o'zbekcha). Serverni qayta ishga tushiring: `sudo systemctl restart sado-speaking`.

## Kompyuterda sinash

```bash
npm install
cp .env.example .env   # API kalitlarini yozing
npm run dev            # http://localhost:3000 (ALLOW_DEV=1 bilan)
```

## Eslatmalar

- Sessiyalar server xotirasida saqlanadi. Server qayta ishga tushsa, davom etayotgan darslar to'xtaydi.
- Har bir gap 3 ta API chaqiruvini ishlatadi (STT, Claude, TTS). Xarajatni `DAILY_SESSIONS` va `SESSION_MINUTES` bilan cheklang.

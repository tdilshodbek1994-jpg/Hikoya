# Serverni ko'chirish (eski server → yangi server)

Barcha ma'lumot (baza, muqovalar, fayllar, `deploy/.env` sozlamalari) bitta arxivga yig'iladi va yangi serverda bitta buyruq bilan tiklanadi. 2026-11-06 da docker'da sinaldi: 6 ta asar ko'chdi, sxema yangilandi, API ishladi.

> ⚠️ Arxiv ichida **bot tokeni va parollar** bor. Uni faqat `scp` bilan ko'chiring, chatga yoki ochiq joyga yubormang, ish tugagach o'chiring.

## Yangi serverni tanlash
- **Telegram'ga to'g'ridan-to'g'ri chiqa olsin.** Tekshirish: `curl -sI https://api.telegram.org | head -1` → `HTTP/... 302` chiqishi kerak. Chiqmasa, bot ishlashi uchun proksi kerak bo'ladi (`HIKOYA_TELEGRAM_PROXY`).
- AI yoqilsa: `curl -sI https://api.anthropic.com | head -1` ham javob berishi kerak.
- Kamida 2 GB RAM (ClamAV yoqilsa 4 GB), 10 GB bo'sh disk.
- 80/443 portlari bo'sh bo'lsa ichki Caddy ishlatiladi; band bo'lsa (boshqa loyiha bor) faqat domen uchun nginx sozlamasi (`deploy/nginx-site.conf`).

## 0. Oldindan (ixtiyoriy, bir kun oldin)
DNS panelida domen `A` yozuvining TTL qiymatini 300 soniyaga tushiring: almashtirganda tez tarqaladi.

## 1. Eski serverda: arxiv
```bash
cd /srv/Hikoya
git pull
STOP=1 sh deploy/migrate-export.sh /root
```
`STOP=1` ilova va botni to'xtatib turadi: shu daqiqadan keyin yangi yozuvlar yo'qolmaydi. Natija: `/root/hikoya-move-YYYYmmdd-HHMMSS.tgz`.

## 2. Yangi serverda: Docker va kod
```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/tdilshodbek1994-jpg/Hikoya.git /srv/Hikoya
cd /srv/Hikoya && git checkout claude/hikoya-environment-setup-0y1h7o
scp root@ESKI_SERVER_IP:/root/hikoya-move-*.tgz /root/
```

## 3. Yangi serverda: tiklash
```bash
cd /srv/Hikoya
sh deploy/migrate-import.sh /root/hikoya-move-YYYYmmdd-HHMMSS.tgz
```
Skript: `.env` ni joyiga qo'yadi → image'larni build qiladi → bazani ishga tushiradi → ma'lumot va fayllarni tiklaydi → migratsiyalarni qo'llaydi → hammasini ishga tushiradi.

Domen o'zgarsa: `nano deploy/.env` (`DOMAIN`, `HIKOYA_PUBLIC_BASE_URL`, `HIKOYA_WEBAPP_URL`, `HIKOYA_CORS_ORIGINS`), keyin `make up`.

## 4. HTTPS
- 80/443 bo'sh: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile https up -d`
- Serverda nginx bor: `deploy/nginx-site.conf` ni [DEPLOY.md](DEPLOY.md) bo'yicha qo'shing, so'ng `certbot --nginx -d DOMEN`.

Sertifikat DNS yangi IP'ga ko'rsatgandan keyingina olinadi, shuning uchun 5-qadamni oldin bajarish mumkin.

## 5. DNS
Domen `A` yozuvini yangi server IP'siga o'zgartiring. Tekshirish:
```bash
curl -s https://DOMEN/api/health        # {"ok":true}
```

## 6. Bot
Telegram yangi serverdan ochiq bo'lsa, proksi kerak emas:
```bash
nano deploy/.env        # HIKOYA_TELEGRAM_PROXY= (bo'sh), HIKOYA_WEBHOOK_SECRET=<openssl rand -hex 32>
make up
make bot-setup          # webhook endi yangi serverga
```
Polling ishlatilgan bo'lsa va webhook'ga o'tilsa, `COMPOSE_PROFILES` dan `polling` ni olib tashlang.

Domen o'zgarmagan bo'lsa, BotFather'da hech narsa o'zgartirish shart emas. Domen o'zgarsa: BotFather → `/myapps` → Mini App → **Edit Web App URL** → `https://YANGI_DOMEN/`.

## 7. Tekshirish ro'yxati
1. Botda `/start` javob beradi, «Ilovani ochish» ishlaydi.
2. Mini App'da asarlar, muqovalar va o'qish joyi saqlangan.
3. Egasi uchun `/admin` ochiladi.
4. Zaxira nusxa cron'larini yangi serverda qayta qo'ying ([BACKUP.md](BACKUP.md)): `backup.sh`, `basebackup.sh`, WAL nusxasi.

## 8. Eski server
Bir hafta kuting (qaytish imkoniyati uchun), keyin:
```bash
cd /srv/Hikoya && docker compose -f deploy/docker-compose.yml --env-file deploy/.env down
```
So'ng `/root/hikoya-move-*.tgz` arxivini ikkala serverdan ham o'chiring.

## Orqaga qaytish
Yangi serverda muammo bo'lsa: DNS'ni eski IP'ga qaytaring va eski serverda `make up` qiling. Ma'lumot eski serverda o'zgarmagan holda turibdi.

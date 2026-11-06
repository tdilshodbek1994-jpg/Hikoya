# Backup, tiklash va avariyadan qaytish

## Kundalik backup

```bash
sh deploy/backup.sh /srv/hikoya-backups
```

Natija ikkita fayl:
- `db-YYYYmmdd-HHMMSS.dump` — PostgreSQL dump (`pg_dump -Fc`);
- `media-….tgz` — fayl ombori.

Cron misoli (har kuni 03:15 Toshkent vaqti):

```
15 3 * * * cd /srv/Hikoya && sh deploy/backup.sh /srv/hikoya-backups >> /var/log/hikoya-backup.log 2>&1
find /srv/hikoya-backups -mtime +30 -delete
```

Backup'larni boshqa serverga yoki obyekt omboriga ham nusxalang (masalan `rclone`).

## Tiklash

Avval **staging**da sinang:

```bash
sh deploy/restore.sh /srv/hikoya-backups/db-….dump /srv/hikoya-backups/media-….tgz
```

Skript API va worker'ni to'xtatadi, bazani qayta yaratadi, dump va media'ni tiklaydi, so'ng servislarni ishga tushiradi.

## Maqsadlar va o'lchovlar

| Ko'rsatkich | Maqsad | Holat |
|---|---|---|
| RPO | 15 daqiqa | Kunlik dump bilan RPO 24 soat. 15 daqiqaga erishish uchun PostgreSQL WAL arxivi (masalan `pgBackRest` yoki `wal-g`) yoqilishi kerak — **hali sozlanmagan** |
| RTO | 2 soat | 2026-11-06 da sinov stack'ida o'lchandi: kichik baza (6 asar) uchun tiklash 16 soniya. Haqiqiy hajmda qayta o'lchash kerak |

Sinov tafsilotlari:
- `backup.sh` ishga tushirildi;
- `works` jadvali o'chirildi;
- `restore.sh` bilan tiklandi;
- natija: 6 asar va 7 revision qaytdi, API ularni ko'rsatdi.

## Avariya rejasi (qisqa)
1. Yangi server: Docker, repozitoriy, `deploy/.env` (sirlar parol menejeridan).
2. `docker compose ... up -d db`, so'ng `restore.sh`.
3. `make up`, `make bot-setup` (webhook yangi manzilga).
4. Bot va Mini App'ni tekshirish: `/start`, katalog, o'qish, `/admin`.
5. To'lovlar: `/admin` → «Premium va to'lovlar» → tekshiruv navbati. Kechikkan `successful_payment` update'larini worker avtomatik qayta ishlaydi.

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

## Uzluksiz WAL arxivi (RPO ≤ 5 daqiqa)

`db` konteyneri `archive_mode=on` bilan ishlaydi: har bir tugagan WAL segmenti gzip qilinib `walarchive` volume'iga (`/wal`) yoziladi. Faollik bo'lsa segment kamida har `WAL_ARCHIVE_TIMEOUT` soniyada (standart 300) yopiladi. Bo'sh vaqtda yangi fayl yaratilmaydi.

Base backup va eski WAL'ni tozalash (har kuni):

```
30 3 * * * cd /srv/Hikoya && sh deploy/basebackup.sh 7 >> /var/log/hikoya-basebackup.log 2>&1
```

`7` — base backup'lar necha kun saqlanadi. Eng eski base backup'dan oldingi WAL avtomatik o'chiriladi (`pg_archivecleanup`).

**Serverdan tashqariga nusxa** (server butunlay yo'qolsa ham RPO saqlanishi uchun), har 5 daqiqada:

```
*/5 * * * * docker run --rm -v hikoya_walarchive:/wal:ro -v /root/.config/rclone:/config/rclone rclone/rclone sync /wal remote:hikoya-wal >> /var/log/hikoya-walsync.log 2>&1
```

`remote:` — `rclone config` bilan sozlangan istalgan obyekt ombori (S3, Backblaze, Google Drive va h.k.).

### Nuqtali tiklash (PITR)

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec db ls /wal/base     # base backup'lar
sh deploy/pitr-restore.sh 20261106-192908 "2026-11-06 19:30:32+05"                          # shu vaqt holatiga
sh deploy/pitr-restore.sh 20261106-192908                                                    # oxirgi arxivlangan WAL'gacha
```

Skript «HA» tasdig'ini so'raydi, api/worker/bot'ni to'xtatadi, joriy baza fayllarini `/wal/pre-restore/` ga saqlab qo'yadi, base backup'ni ochadi va WAL'ni kerakli vaqtgacha qo'llaydi. `database system is ready` chiqqach: `make up`.

## Tiklash (kunlik dump'dan)

Avval **staging**da sinang:

```bash
sh deploy/restore.sh /srv/hikoya-backups/db-….dump /srv/hikoya-backups/media-….tgz
```

Skript API va worker'ni to'xtatadi, bazani qayta yaratadi, dump va media'ni tiklaydi, so'ng servislarni ishga tushiradi.

## Maqsadlar va o'lchovlar

| Ko'rsatkich | Maqsad | Holat |
|---|---|---|
| RPO | 15 daqiqa | WAL arxivi bilan ≤ 5 daqiqa (`WAL_ARCHIVE_TIMEOUT=300`). Server yo'qolishiga qarshi — yuqoridagi `rclone` cron (5 daqiqa) |
| RTO | 2 soat | 2026-11-06 da sinov stack'ida o'lchandi: kichik baza (6 asar) uchun tiklash 16 soniya. Haqiqiy hajmda qayta o'lchash kerak |

PITR sinovi (2026-11-06, docker, postgres:16-alpine):
- WAL segmentlari `/wal` ga gzip bilan tushdi;
- `basebackup.sh` → keyin yangi qator qo'shildi → vaqt belgilandi → jadval o'chirildi;
- `pitr-restore.sh BASE "vaqt"` → jadval ikkala qator bilan qaytdi (base backup'dan keyingisi ham), o'chirish qo'llanmadi;
- eski WAL'lar base backup'dan keyin avtomatik tozalandi.

Dump sinovi:
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

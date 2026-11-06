# Yuklama testi (T-62)

## Sharoit
- Sana: 2026-11-06.
- Mashina: 4 vCPU, 15 GB RAM, bitta host. PostgreSQL 16, API (3 ta uvicorn worker) va yuklama generatori — hammasi shu mashinada ishladi, ya'ni generator ham CPU'ni egalladi.
- Dataset (`backend/loadtest/seed.sql`): 2 000 asar, 20 000 bob, 100 000 hisob, 1 000 000 reading event, 300 000 qualified read. Bu sun'iy hajm, biznes prognozi emas.
- Profil (`backend/loadtest/run.py`):
  - 500 ta bir vaqtda faol o'quvchi, har biri o'rtacha 5 soniyada bitta so'rov yuboradi (≈100 so'rov/s);
  - so'rovlar aralashmasi: bob matni 30%, progress 30%, eventlar 15%, bosh sahifa 10%, katalog 10%, TOP 5%;
  - davomiyligi 60 soniya.
- Production sozlamalari (`HIKOYA_ENV=production`), DB pool: har worker'da 20 + 20 ulanish.

## Natija (oxirgi o'lchov)

| Endpoint | So'rovlar | p50 | p95 | p99 | Maqsad (p95) |
|---|---|---|---|---|---|
| Bosh sahifa `/home` | 663 | 60 ms | **285 ms** | 521 ms | ≤ 400 ms ✓ |
| Katalog `/works` | 626 | 55 ms | **186 ms** | 392 ms | ≤ 400 ms ✓ |
| TOP `/rankings` | 343 | 22 ms | 165 ms | 496 ms | ≤ 400 ms ✓ |
| Bob matni `/chapters/{id}/content` | 1 955 | 21 ms | **136 ms** | 321 ms | ≤ 500 ms ✓ |
| Progress `PUT /reading/progress` | 1 981 | 18 ms | 161 ms | 394 ms | — |
| Eventlar `POST /reading/events/batch` | 567 | 20 ms | 76 ms | 192 ms | — |

- Xatolar: **0%** (6 135 so'rov). Ularning 60 soniyalik oyna ichidagisi ≈ 100 so'rov/s.
- To'liq natija: `loadtest-result.json`.

## O'lchovlar tarixi (nima o'zgardi)

| Holat | Bosh sahifa p95 | Katalog p95 | Bob p95 |
|---|---|---|---|
| Standart DB pool (5 + 10) | 910 ms | 793 ms | 635 ms |
| Pool 20 + 20 | 510 ms | 289 ms | 192 ms |
| + janrlar ro'yxati 60 soniyalik keshda | 285 ms | 186 ms | 136 ms |

## Cheklovlar
- Mobil mijozdagi «asosiy ekran p75 ≤ 2.5 s (4G)» maqsadi o'lchanmadi. Bunga haqiqiy qurilma va tarmoq profili kerak.
- Media trafigi (rasm va audio) testga kirmadi. Ular nginx yoki S3 orqali beriladi.
- Rate limit va kesh har bir jarayon ichida ishlaydi. Bir nechta serverga kengaytirilganda Redis kerak bo'ladi ([ARCHITECTURE.md](ARCHITECTURE.md)).
- Qayta ishga tushirish:
  ```bash
  psql -f backend/loadtest/seed.sql
  python backend/loadtest/run.py --base http://127.0.0.1:8100 --users 500 --seconds 60
  ```

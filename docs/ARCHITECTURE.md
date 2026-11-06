# Arxitektura

## Jarayonlar

| Jarayon | Buyruq | Vazifa |
|---|---|---|
| API | `uvicorn app.main:app` | Mini App API, Telegram webhook (`/api/v1/telegram/webhook`) |
| Worker | `python -m app.workers` | rejalashtirilgan nashr, outbox → bildirishnomalar, Telegram'ga yetkazish, eskirgan buyurtmalar, to'lov update'larini tiklash, TOP snapshotlari |
| Bot (ixtiyoriy) | `python -m app.bot polling` | webhook bo'lmagan muhit uchun long-polling |
| Web | nginx | Mini App statik fayllari, `/api` va `/media` proxy |

Uchala Python jarayoni bitta kod bazasi va bitta `services` qatlamidan foydalanadi. Biznes qoidasi (nashr, kirish huquqi, to'lov) faqat bitta joyda yozilgan (F-14).

```
Mini App / Bot → identity + permissions → services (domain) → PostgreSQL tranzaksiya → outbox → worker → Telegram
```

## Muhim qarorlar

1. **Kirish huquqi faqat serverda** (`app/services/access.py`). Tartib spec 19.5 bo'yicha:
   - avval suspended holati;
   - keyin nashr qilingan revision bor-yo'qligi;
   - bepul namuna yoki bepul bob;
   - shu asar uchun xarid granti;
   - Premium granti (faqat `PREMIUM*` siyosatida);
   - aks holda locked.

   Pulli matn hech qachon to'liq yuborilmaydi. Mijoz faqat `preview_blocks` ta blokni oladi. Bitta qoida reader, sharhlar, audio/fayllar, matn ichida qidiruv va storis uchun ishlaydi.
2. **O'zgarmas revisionlar.** `chapter_revisions` jadvalidagi yozuv hech qachon yangilanmaydi.
   - Saqlash `base_revision_id` bilan keladi; eskirgan bo'lsa server 409 qaytaradi.
   - Har bir blokda barqaror `bid` bor. O'qish joyi, xatcho'p va iqtibos shu ID'ga bog'lanadi.
   - Blok o'chirilsa, joy eng yaqin saqlangan blokka ko'chiriladi.
3. **O'qish progressi.**
   - `current_*` — o'quvchining oxirgi ongli joyi; `furthest_*` hech qachon kamaymaydi.
   - Bir qurilmadan kelgan eski sequence e'tiborga olinmaydi.
   - Boshqa qurilmadan kelgan eski holat yangisini jim bosib ketmaydi: `conflict` qaytadi va foydalanuvchi tanlaydi.
4. **TOP.** «Eng ko'p o'qilgan» = davr ichidagi noyob malakali o'quvchilar soni.
   - Malakali o'qish: bloklarning kamida 20 foizi ko'rilgan; faol vaqt ≥ max(8 s, min(45 s, bob vaqtining 50%)); tezlik soxta emas.
   - Muallifning o'zi, preview va test hisoblar hisobga olinmaydi.
   - Davrlar Asia/Tashkent vaqti bo'yicha. Trend formulasi alohida (`trend-v1`).
5. **To'lovlar** (`app/services/billing.py`):
   - Har bir order uchun yagona `invoice_payload` va o'zgarmas snapshot.
   - `update_id` ham, `telegram_payment_charge_id` ham bir martalik.
   - payment, grant va outbox bitta tranzaksiyada yoziladi.
   - Obuna update'i (`canceled` / `active` / `failed`) faqat `renewal_state` ni o'zgartiradi.
   - Refund faqat o'z grantini bekor qiladi; `refunded_charges` tombstone kechikkan to'lovning grantni qayta ochishiga yo'l qo'ymaydi.
   - Parallel xarid `purchase_intent_locks` (`SELECT … FOR UPDATE`, lock_timeout 3 s) bilan boshqariladi.
6. **Bot dispatcher.** O'zimizniki, xom update'lar bilan ishlaydi (aiogram ishlatilmaydi).
   - Sabab: to'lov va obuna update'lari SDK versiyasiga bog'liq bo'lmasin va jim tashlab yuborilmasin.
   - Dialog holati `bot_dialogs` jadvalida, shuning uchun qayta ishga tushganda davom etadi.
   - pre_checkout tez yo'ldan javob oladi, media ishlari navbatida turmaydi.
7. **Redis ishlatilmaydi** (birinchi reliz uchun ataylab qilingan qaror):
   - ish navbati — PostgreSQL (`publish_jobs` atomik claim, `outbox_events` va `deliveries` uchun SKIP LOCKED);
   - rate limit — jarayon ichida;
   - Redis o'chib qolishi bilan bog'liq xavf yo'q.
   - Yuklama oshsa: rate limit va cache Redis'ga ko'chiriladi (kodda bitta joy: `app/api/deps.py`).
8. **Media.**
   - Fayl turi magic bytes bo'yicha aniqlanadi; hajm limitlari konfiguratsiyada.
   - DOCX uchun zip-bomb himoyasi bor; makroslar bajarilmaydi.
   - Muqovalar ochiq (`public/`), originallar yopiq (`private/`) saqlanadi.
   - Yopiq fayl 60 soniyalik HMAC-imzolangan havola orqali beriladi. Kirish huquqi har so'rovda qayta tekshiriladi.
9. **Matn sxemasi.** Tiptap/ProseMirror JSON'ining cheklangan qismi ishlatiladi:
   - bloklar: paragraph, heading 2/3, blockquote, horizontalRule, image;
   - belgilar: bold, italic.

   Server HTML, havola va noma'lum tugunlarni tashlab yuboradi. Sharhlar oddiy matn sifatida saqlanadi va React escape qiladi.

## Ma'lumot modeli (asosiy jadvallar)

Asosiy jadvallar soni 71 ta (`migrations/versions/0001_initial_schema.py`):

- **identity:** users, sessions, role_grants, audit_log, author_profiles, author_memberships, bot_dialogs, app_settings
- **katalog:** genres, tags, works, work_genres, work_tags, work_contributors, home_sections, curated_collections, curated_items, ranking_snapshots
- **kontent:** chapters, chapter_revisions, editorial_reviews, publish_jobs, editor_notes, content_issues, assets, asset_links, import_jobs
- **o'qish:** reading_sessions, reading_progress, chapter_completions, reading_events, qualified_reads, bookmarks, reader_highlights, private_notes, library_items, user_collections, user_collection_items, recent_searches, dismissals
- **ijtimoiy:** likes, thanks, follows, comments, comment_votes, reports, moderation_actions, user_restrictions
- **storis:** author_stories, story_frames, story_views, story_actions, story_highlights, story_highlight_items
- **to'lov:** products, product_versions, orders, purchase_intent_locks, subscriptions, payments, telegram_updates, refunds, refunded_charges, entitlement_grants, support_tickets, support_messages
- **bildirishnoma:** notification_preferences, notifications, deliveries, outbox_events, telegram_calls

## Rollar

Rollar quyidagi vakolatlar to'plamidan iborat (`app/core/permissions.py`):

| Rol | Asosiy vakolatlar |
|---|---|
| `owner` | hammasi |
| `content_admin` | asar va storis nashri, katalog, mualliflar, statistika. Narx, refund va rollar berilmaydi |
| `editor` | biriktirilgan asarni tahrirlash va tekshirish |
| `moderator` | sharh va storis moderatsiyasi |
| `author` | o'z asarlari va storisi |
| `support` | murojaatlar va to'lovlarni ko'rish |

Rollar har API so'rovida bazadan qayta o'qiladi: rol olinsa, darhol ishlamay qoladi. Boshqa muallifning qoralamasi 404 qaytaradi, shu bilan uning mavjudligi ham sir saqlanadi.

## API
To'liq shartnoma: [`openapi.json`](openapi.json). Lokal muhitda interaktiv ko'rinish: `/api/docs` (production'da o'chirilgan).

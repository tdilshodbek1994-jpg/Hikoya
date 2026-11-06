# Qabul sinovlari (T-01 … T-64)

Holatlar:
- **passed** — avtomatlashtirilgan dalil bor;
- **qisman** — asosiy qism tekshirilgan, qolgani yozilgan;
- **not_run** — hali bajarilmagan;
- **n/a** — modul birinchi relizda yo'q.

Dalil manbalari:
- `P:` — pytest testi (`backend/tests`). Natija: **63 passed** (2026-11-06, PostgreSQL 16, Python 3.13, lock fayldagi versiyalar).
- `E:` — 360 px telefon emulyatsiyasidagi Playwright smoke testi (`frontend/miniapp/e2e/smoke.cjs`). Natija: **16/16 passed**. Natija va skrinshotlar: `docs/screenshots/`.

Muhim: barcha Telegram chaqiruvlari soxta Bot API bilan sinaldi, chunki bu muhitda bot tokeni ham, Telegram tarmog'i ham yo'q. Haqiqiy qurilmada va haqiqiy Telegram klientida hali sinalmagan. Buni deploydan keyin [STATUS.md](STATUS.md) dagi ro'yxat bo'yicha qilish kerak.

| # | Sinov | Holat | Dalil / izoh |
|---|---|---|---|
| T-01 | Janr tanlashni o'tkazish, katalog ochiladi, telefon so'ralmaydi | passed | P: `test_onboarding_skip_and_catalog_opens`; E: «T-01» |
| T-02 | 360 px: storis va janr qatori tepada, nav yopmaydi, overflow yo'q | passed | E: «T-02» (3 ta tekshiruv), «tap targets ≥ 44px»; `screenshots/01-home*.png` |
| T-03 | Premium + Detektiv + Tugallangan | passed | P: `test_filters_premium_genre_completed`; E: «T-03» |
| T-04 | «Barchasini ko'rish» filtr va tartibni saqlaydi | passed | P: `test_demo_seed_marked_and_no_fake_counters` (see_all = lenta filtri) |
| T-05 | Lotin/kirill va turli apostrof bilan qidiruv | passed | P: `test_search_cyrillic_and_apostrophe`, `test_search_normalisation_script_and_apostrophes`; E: «T-05» |
| T-06 | Storisdan yangi bobga: ruxsatsizga namuna/paywall | passed | P: `test_story_premium_frame_locked_and_chapter_link` |
| T-07 | Telegram Premium bo'lmagan muallif storis joylaydi | passed | P: `test_story_needs_review_then_visible_and_expires` |
| T-08 | expires_at o'tgan, scheduler to'xtagan → API bermaydi | passed | P: `test_story_needs_review_then_visible_and_expires` |
| T-09 | Bepul user Premium storis ID'sini so'raydi | passed | P: `test_story_premium_frame_locked_and_chapter_link` (matn/media `null`) |
| T-10 | «Tanlangan» doimiy, siyosat saqlanadi | passed | P: `test_story_highlight_keeps_premium_policy` |
| T-11 | Shrift 16→28, joy blokka bog'langan | passed | P: `test_font_change_keeps_block_anchor_and_text_edit_maps_position` |
| T-12 | Bob o'rtasida yopib ochish → shu joydan | passed | E: «T-12» (scrollY tiklandi); P: `test_progress_current_vs_furthest_and_stale_events` |
| T-13 | 7-bobdan 2-bobga: current yangilanadi, furthest kamaymaydi | passed | P: `test_progress_current_vs_furthest_and_stale_events` |
| T-14 | Eski event keyin keladi | passed | P: o'sha test (`stale_ignored`) |
| T-15 | Ikki qurilma | passed | P: `test_two_devices_conflict`; UI: tanlov oynasi (`ConflictDialog`) |
| T-16 | Internet uzilib qaytadi, bir marta sinxron | passed (server) | P: `test_duplicate_events_resent_offline`. Mijoz navbati `lib/offline.ts` da; qurilmada oflayn sinov — not_run |
| T-17 | Xatcho'p turgan paragraf o'chirilgan | passed | P: `test_font_change_keeps_block_anchor_and_text_edit_maps_position`, `test_nearest_preserved_block` |
| T-18 | Layk 5 marta | passed | P: `test_like_idempotent` |
| T-19 | Rahmat bepul, invoice yo'q | passed | P: `test_thanks_free_and_idempotent` |
| T-20 | Rahmat takrori, sabab saqlanadi | passed | P: `test_thanks_free_and_idempotent` |
| T-21 | Sharh yuborishda xato → matn saqlanadi | qisman | P: `test_comment_retry_same_client_key_and_xss_text` (takror yuborish dublikat bermaydi). UI matnni localStorage'da saqlaydi (`Comments.tsx`); avtomatik UI testi yo'q |
| T-22 | O'qilmagan bob sharhida spoiler | passed | P: `test_chapter_spoiler_hidden_until_read`; javob bildirishnomasida sharh matni yo'q (`notify.py`) |
| T-23 | Sharhda script/HTML | passed | P: `test_comment_retry_same_client_key_and_xss_text`, `test_sanitize_removes_html_and_unknown_nodes` |
| T-24 | Muallif tanqidni izsiz o'chira olmaydi | passed | P: `test_author_cannot_delete_criticism` |
| T-25 | 1 user, 20 marta, 6 bob → haftada 1 | passed | P: `test_qualified_read_unique_per_period` |
| T-26 | Muallif o'z asarini ochadi → TOPga qo'shilmaydi | passed | P: `test_author_own_reading_not_counted`; studio preview sessiya yaratmaydi |
| T-27 | 3 kun o'qish → haftalikda 1 | passed | P: `test_qualified_read_unique_per_period` |
| T-28 | Bot hikoya qo'shish o'rtasida qayta ishga tushadi | passed | P: `test_bot_add_story_end_to_end_with_restart` |
| T-29 | Bir xil DOCX ikki marta | passed | P: `test_bot_docx_import_and_duplicate` |
| T-30 | Import faylining bo'limi buzilgan | qisman | P: `test_broken_import_keeps_published_text` (buzilgan DOCX rad etiladi, nashr o'zgarmaydi). Faylning faqat bir bo'limi buzilgan holat alohida sinalmagan |
| T-31 | Nashrdan keyin tahrir → o'quvchi eski revisionni ko'radi | passed | P: `test_edit_after_publish_keeps_old_revision_for_readers` |
| T-32 | Ikki muharrir bir base → 409 | passed | P: `test_concurrent_save_conflict`; UI: lokal nusxa saqlanadi |
| T-33 | Eski revisionga qaytish | passed | P: `test_restore_old_revision_keeps_history` |
| T-34 | Ikki worker bir job | passed | P: `test_publish_job_once_and_reschedule` (parallel `gather`) |
| T-35 | Jadval o'zgartiriladi | passed | P: o'sha test (eski job `canceled`) |
| T-36 | Muallif A muallif B draftini so'raydi | passed | P: `test_other_authors_draft_is_invisible` (5 ta endpoint, hammasi 404) |
| T-37 | Rol muharrir ochiq paytda olinadi | passed | P: `test_role_revoked_while_editor_open` (API va botdagi eski tugma) |
| T-38 | initData buzilgan / user_id almashtirilgan | passed | P: `test_init_data_tampered_user_id_rejected`, `test_init_data_wrong_token_and_expired` |
| T-39 | Telegram is_premium, grant yo'q | passed | P: `test_telegram_premium_flag_is_not_entitlement` |
| T-40 | Frontend «paid», backendda payment yo'q | passed | P: `test_client_paid_without_payment_does_not_unlock` |
| T-41 | successful_payment 3 marta | passed | P: `test_full_payment_flow_and_triple_update` |
| T-42 | Ikki qurilmada bir vaqtda xarid | qisman | P: `test_parallel_checkouts_reuse_one_intent` (bitta niyat, ikkinchi obuna rad). Ikkinchi haqiqiy to'lov → review oqimi kodda bor (`billing.py`), alohida sinalmagan |
| T-43 | Checkoutdan so'ng narx o'zgaradi | passed | P: `test_price_change_after_checkout` (renewal ham qabul qilinadi) |
| T-44 | pre_checkout tez javob | passed | P: `test_full_payment_flow_and_triple_update` (< 2 s, soxta API). Real tarmoq kechikishi o'lchanmagan |
| T-45 | 20-kuni yangilanishni bekor qilish | passed | P: `test_subscription_states_do_not_extend` |
| T-46 | state=active, yangi payment yo'q | passed | P: o'sha test |
| T-47 | state=failed | passed | P: o'sha test (+ noma'lum holat saqlanadi) |
| T-48 | Server vaqti = paid_until | passed | P: `test_access_ends_exactly_at_paid_until` |
| T-49 | Bitta asar to'lovi qaytariladi | passed | P: `test_refund_only_revokes_its_grant` |
| T-50 | Refund oldin, payment keyin | passed | P: `test_refund_before_late_payment` |
| T-51 | Refund javobi noaniq | passed | P: `test_refund_uncertain_then_retry` |
| T-52 | Premium bob API/asset; PURCHASE asarni Premium ochmaydi | passed | P: `test_premium_chapter_returns_only_preview`, `test_purchase_policy_not_opened_by_premium`, `test_private_asset_requires_entitlement_and_refund_blocks_new_links`; E: «T-52» |
| T-53 | Refunddan keyin yangi private asset so'rovi | passed | P: `test_private_asset_requires_entitlement_and_refund_blocks_new_links`, `test_signed_link_expires` |
| T-54 | Delisted asar oldingi xaridorga ochiq | passed | P: `test_delisted_work_stays_open_for_buyer` |
| T-55 | Botga yozish roziligi rad | passed | P: `test_bot_consent_refused_reader_still_works` |
| T-56 | 5 asarda bir vaqtda bob | passed | P: `test_five_new_chapters_grouped_digest` |
| T-57 | Telegram 429 / bot bloklangan | passed | P: `test_telegram_429_and_blocked` |
| T-58 | Muallif statistika eksporti | qisman | Faqat umumlashtirilgan statistika beriladi (`/studio/works/{id}/stats`), kam namunada nozik kesimlar yashiriladi. Fayl ko'rinishidagi eksport yo'q |
| T-59 | AI'ga keyingi bobni so'rash | n/a | AI moduli birinchi relizda yo'q (C bosqichi) |
| T-60 | AI provayderi ishlamaydi | n/a | Hech qaysi funksiya AI'ga bog'liq emas |
| T-61 | Katalog bo'sh | qisman | API bo'sh bo'limlarni qaytaradi, UI'da bo'sh holat va boshqa bo'limga yo'l bor (`Home.tsx`, `Catalog.tsx`). Avtomatik UI testi yo'q |
| T-62 | 500 faol reader yuklamasi | not_run | Yuklama testi bajarilmagan |
| T-63 | Backupdan tiklash | qisman | `deploy/backup.sh` → o'chirish → `restore.sh` sinov stack'ida bajarildi: kichik baza, 16 s. RPO o'lchanmagan, WAL arxivi yo'q ([BACKUP.md](BACKUP.md)) |
| T-64 | Eski Telegram klienti | not_run | Kodda imkoniyatlar oldindan tekshiriladi va fallback bor (`lib/tg.ts`). Haqiqiy eski klientda sinalmagan |

**Jami (64):** 54 passed (shundan T-16 faqat server qismi), 6 qisman, 2 not_run, 2 n/a.

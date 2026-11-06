# Holat hisoboti — 2026-11-06

## Qisqacha
- **A bosqichi** (poydevor va vertikal oqim) va **B bosqichi** (birinchi to'liq reliz) kod darajasida tayyor.
- Tayyorlik avtomatik testlar va 360 px smoke testi bilan tekshirildi.
- **Hali qilinmagan:** haqiqiy bot tokeni bilan Telegram ichida sinov va haqiqiy Stars to'lovi. Yuklama testi bajarildi ([LOADTEST.md](LOADTEST.md)).
- C bosqichi asosan tayyor: AI yordamchi (ixtiyoriy), «Qayerda to'xtagandim?», qahramonlar, beta-o'quvchilar, inline izohlar, iqtibos kartasi, sovg'a, muallif ulushi, EPUB/PDF import, antivirus, WAL arxivi. Qilinmaganlari pastda aniq yozilgan.

## Bajarilgan

| Bo'lim | Holat |
|---|---|
| Telegram orqali kirish | initData server tekshiruvi (5 daqiqa), server sessiyasi, sessiyalar ro'yxati va bekor qilish |
| Rollar | 6 rol va mayda vakolatlar; har so'rovda tekshiriladi |
| Kontent | asar, bob, o'zgarmas revisionlar, 409 ziddiyat, tarix, diff, qaytarish, audit |
| Nashr | tekshiruv navbati, rejalashtirish (bir marta bajariladi, qayta rejalashtirish), delist/arxiv/suspend/tiklash |
| Kirish huquqi | 19.5 bo'yicha: bepul namuna, `free_after`, `locked_until`, PREMIUM / PURCHASE / PREMIUM_OR_PURCHASE |
| Katalog | admin boshqaradigan bosh sahifa lentalari, tahririyat tanlovi (homiylik belgisi bilan), janrlar, filtrlar, lotin/kirill/apostrof qidiruvi, xatoga chidamli qidiruv, ruxsatli to'liq matn qidiruvi |
| TOP | noyob malakali o'quvchilar, Toshkent davrlari, trend alohida, snapshot tarixi |
| Reader | 3 fon, 16–28 px, serif/sans, qator oralig'i, kenglik, progress chizig'i, mundarija, xatcho'p, iqtibos, shaxsiy eslatma, xato xabari, asl yozuvga qaytish, offline navbat, oxirgi 3 bob keshi |
| Progress | current/furthest alohida; sequence, ikki qurilma ziddiyati, matn tahririda blokni moslash |
| Storis | 6 xil lavha, Premium lavha, 24/48/72 soat, tekshiruv yoki darhol nashr, ko'rilgan/ko'rilmagan, 2 soniya qoidasi, so'rov, analitika, tanlanganlar |
| Ijtimoiy | layk, bepul rahmat (sabab bilan), kuzatish, sharh/javob/foydali/biriktirish, spoiler qoidalari, shikoyat, moderatsiya (sabab va audit bilan), vaqtli cheklov |
| Kutubxona | davom ettirish, saqlanganlar, o'qiyapman, tugatganlar, sotib olinganlar, iqtiboslar va eslatmalar, shaxsiy to'plamlar |
| To'lov | Stars obunasi (30 kun), bir martalik paketlar, asar xaridi, order snapshot, idempotency, refund, obuna boshqaruvi, /paysupport, murojaatlar |
| Bildirishnoma | ilova ichidagi markaz, bot roziligi, tezkor yoki yig'ma rejim, sokin vaqt, 429/blok himoyasi |
| Bot | o'quvchi menyusi; vakolatga qarab admin panel; hikoya qo'shish (16 qadam, qayta ishga tushganda davom etadi); fayl importi; storis; tekshiruv; taqvim; statistika; `/grant`; `/price` |
| Ijod ustaxonasi | Tiptap muharriri (barqaror blok ID, avtomatik saqlash), import, preview, tarix, rejalashtirish, fayllar va audio, storis yaratish, muallif dashboardi va statistikasi |
| Admin | moderatsiya navbati, bosh sahifa, janrlar, xodimlar, mualliflar, narxlar, refund, murojaatlar, audit, umumiy statistika |
| Shaxsiy ma'lumot | eksport (JSON) va o'chirish so'rovi |
| Rasmlar | 240/640 px WebP variantlar; EXIF va GPS ma'lumotlari olib tashlanadi; decompression-bomb himoyasi |
| O'qish ritmi | haftalik hisobot, kunlik maqsad, ketma-ket kunlar (faqat foydalanuvchiga ko'rinadi) |
| Import | buzilgan baytlar va Windows-1251 kodlashi ogohlantirish bilan import qilinadi |
| Muallif statistikasi | ekranda va CSV eksportda, faqat umumlashtirilgan raqamlar |
| Qayerda to'xtagandim? | muallif bob uchun qisqa mazmun yozadi; keyingi bob ochilganda faqat oldingi bobni o'qib bo'lganlarga ko'rsatiladi |
| Qahramonlar | rasm va tavsifli kartalar; «shu bob o'qilgandan keyin ochiladi» sozlamasi (spoilersiz) |
| Beta-o'quvchilar | nashr qilinmagan qoralama uchun shaxsiy havola (`b_` deep link), bitta odamga biriktiriladi, muddatli, bekor qilinadi; xatboshiga bog'langan fikr muallif muharririda «[Beta]» bilan chiqadi; statistikaga kirmaydi |
| Inline izohlar | o'quvchi matn bo'lagini belgilab «Shu joyga izoh» yozadi; blok yonida 💬 soni; izohlar ro'yxati shu blok bo'yicha filtrlanadi |
| Iqtibos kartasi | 1080×1920 PNG (Pillow, DejaVu shrifti), faqat nashr qilingan va o'quvchiga ochiq matndan; Telegram `shareToStory` yoki havola; muallif uchun bir bosishda storis qoralamasi |
| Sovg'a | bir martalik Premium paket yoki asarni do'stga (Telegram ID orqali) sotib olish; huquq oluvchiga beriladi, unga bildirishnoma boradi; obunani sovg'a qilib bo'lmaydi (Stars obunasi to'lovchiniki) |
| Muallif ulushi | alohida sotilgan asardan foiz (`HIKOYA_ROYALTY_SHARE_PERCENT`); kutilmoqda → tayyor (refund muddati o'tgach) → to'langan; refundda qaytariladi; to'lov ilovadan tashqarida qilinib admin panelda qayd etiladi |
| AI (ixtiyoriy) | rasmiy `anthropic` SDK, `claude-opus-5-5`, structured output, rad javobida server-side fallback; muallif: annotatsiya variantlari, imlo takliflari (bittalab qabul, yangi qoralama versiya); o'quvchi: o'qiganigacha qisqa mazmun (faqat o'qilgan va ochiq boblar), tabiiy tilda qidiruv; har chaqiruv jurnalda, kunlik limit |
| Import | TXT, Markdown, DOCX, EPUB (spine tartibi), PDF (matn qatlami; skaner qilingan PDF uchun aniq xabar) |
| Tarmoqlanuvchi hikoyalar | bob oxirida 4 tagacha tanlov (matn + qaysi bobga); o'quvchiga «Keyingi bob» o'rniga tanlov tugmalari; qulflangan yo'l belgilanadi, ochilmaydi; tanlovni o'zgartirish mumkin; boshqa o'quvchilar foizi faqat tanlagandan keyin ko'rinadi; spoiler qoidasi tarmoqli asarda faqat tugatilgan boblarga tayanadi |
| Audio va matn | muallif audioni tinglab, har xatboshi boshlanganda unga bosadi; o'quvchida o'qilayotgan xatboshi yoritiladi va ekran unga suriladi; xatboshiga bosilsa audio o'sha joydan davom etadi (xatboshi darajasida, so'z darajasida emas) |
| Analitika (egasi uchun) | 7/30/90 kun: faol o'quvchilar, yangi foydalanuvchilar, Stars tushumi (kunlik ustunlar + jadval), voronka (kirdi → boshladi → haqiqatan o'qidi → to'ladi), D1/D7 qaytish, eng ko'p o'qilgan 5 asar bo'yicha boblarda «tashlab ketish»; faqat umumiy raqamlar, test va demo chiqarilgan |
| Ulashish | yagona «Ulashish» oynasi (asar, muallif, bob oxiri, taklif): **chatga karta** (Bot API 8.0 `savePreparedInlineMessage` + `shareMessage`: muqova, nom, muallif, annotatsiya va «📖 O'qish» tugmasi; eski klientda oddiy havola), **storis kartasi** 1080×1920, havola nusxasi, tizimning ulashish oynasi; **inline rejim** — istalgan chatda `@bot so'z` → asarlar kartasi; har ulashish havolasi (`__s<id>`) necha kishi ochganini va nechta yangi o'quvchi kelganini sanaydi; ulashish orqali kelgan yangi foydalanuvchi taklif mukofotiga ham hisoblanadi; muallif statistikasida kanal bo'yicha |
| Promo-kodlar | admin kod yaratadi (N kun Premium, limit, muddat, faqat yangi foydalanuvchilar); o'quvchi Premium sahifasida kiritadi; har kim bir marta; o'chirilgan/noma'lum kod bir xil xabar beradi; urinishlar cheklangan |
| Do'stni taklif qilish | Profil'da shaxsiy havola (`r_<id>`); faqat havola orqali yangi ochilgan hisob bog'lanadi; taklif qiluvchi do'sti birinchi haqiqiy o'qishni (qualified read) qilgandan keyin N kun Premium oladi; oyiga limit; bildirishnoma |
| Rus tili | interfeys tarjimasi (Profil → «Ilova tili»), 700+ matn; asarlar va admin kiritgan bo'lim nomlari tarjima qilinmaydi; `npm run i18n-check` tarjimasiz matnni ko'rsatadi |
| Media | MP4/M4A davomiyligi serverda o'qiladi (storis video chegarasi ishlaydi); ixtiyoriy ClamAV tekshiruvi |
| Deploy | Docker image'lar, docker-compose, Caddy HTTPS, `.env.example`, Makefile, backup/restore. Bu muhitda build va ishga tushirish sinaldi |

## Cheklovlar va ochiq savollar
1. **Telegram'da real sinov yo'q.** Bot tokeni va Telegram tarmog'i bo'lmagani uchun barcha Telegram chaqiruvlari soxta API bilan sinaldi. Deploydan keyingi tekshiruv ro'yxati quyida.
2. **Skrinshotlar.** Topshiriqdagi 5 ta YANGI.TV skrinshoti paketda yo'q edi. Dizayn matnli tavsif va berilgan ranglar asosida qilindi. Skrinshotlar yuborilsa, solishtirib moslashtiraman.
3. **WAL arxivi serverning o'zida.** Server butunlay yo'qolishiga qarshi `rclone` cron'ini yoqish kerak ([BACKUP.md](BACKUP.md)).
4. **Antivirus ixtiyoriy.** ClamAV ~1.2 GB RAM talab qiladi, shuning uchun standart o'chiq (`--profile antivirus`).
5. **AI kalit talab qiladi.** `HIKOYA_AI_PROVIDER=anthropic` va `HIKOYA_AI_API_KEY` `.env` da bo'lmasa, AI tugmalari umuman ko'rinmaydi. Haqiqiy API bilan sinalmagan (testlar soxta provayder bilan); so'rov shakli SDK'ga qarshi tekshirilgan.
6. **Rus tili:** UI matnlari alohida lug'atga ajratilgan. Rus tarjimasi hali qo'shilmagan.
7. **Redis ishlatilmaydi** (ataylab qilingan qaror, [ARCHITECTURE.md](ARCHITECTURE.md)). Rate limit jarayon ichida ishlaydi. Bir nechta API nusxasi ishga tushirilsa, Redis'ga ko'chirish kerak.
8. **Sovg'a qabul qiluvchisi Telegram ID bilan topiladi** (username bilan qidirish spec bo'yicha taqiqlangan). ID Profil sahifasida ko'rsatiladi.

## Bajarilmagan (ataylab qoldirilgan)
- **So'zma-so'z audio yoritish** — nutqni aniqlash modeli kerak; hozir xatboshi darajasida sinxron bor.
- **OCR** (skaner qilingan PDF/rasm) — og'ir model; hozir aniq xabar bilan rad etiladi.
- **Bot xabarlari rus tilida** — bot matnlari hozircha faqat o'zbekcha (Mini App interfeysi ruscha bo'la oladi).
- **Royalti avtomatik to'lovi** — Stars'ni muallifga avtomatik o'tkazish API'si yo'q; to'lov qo'lda qilinib qayd etiladi.

## Deploydan keyingi tekshiruv ro'yxati (real Telegram)
1. `/start` → menyu, «Ilovani ochish», rozilik so'rovi.
2. Mini App: kirish, onboarding, bosh sahifa, 360 px telefonda ko'rinish, safe area, orqaga tugmasi.
3. `/admin` → «Hikoya qo'shish» oqimi (matn, DOCX, muqova) → nashr → o'quvchi topib o'qiydi.
4. Reader: joyni saqlash, ikki qurilma, internet uzilishi.
5. Storis: yaratish, ko'rish, havola.
6. Test muhitida Stars: obuna, pre-checkout, to'lov tasdig'i, bekor qilish, refund (`HIKOYA_TELEGRAM_TEST_ENV=true`).
7. Bildirishnomalar: yangi bob, sokin vaqt.
8. Eski Telegram klienti (T-64).

## Keyingi checkpoint
1. Siz serverga deploy qilasiz ([DEPLOY.md](DEPLOY.md)) va bot tokeni bilan yuqoridagi ro'yxatni o'tamiz.
2. Topilgan xatolarni tuzataman. Skrinshotlar bo'lsa, dizaynni moslashtiraman.
3. Kerak bo'lsa: AI kalitini ulash, royalti foizini belgilash, ClamAV va WAL nusxasini serverdan tashqariga yoqish.

## Raqamlar
- Backend: 83 jadval, 164 API yo'li, 106 avtomatik test (unit + integratsiya, haqiqiy PostgreSQL).
- Frontend: 30+ ekran, o'quvchi bundle'i ~125 KB gzip, studio alohida lazy chunk.
- Smoke: 360 px, 18/18 (asosiy) + 15/15 (C bosqichi, `e2e/stage_c.cjs`) + 7/7 (D bosqichi, `e2e/stage_d.cjs`). Tarjima to'liqligi: `npm run i18n-check`.
- Yuklama: 500 o'quvchi, ~100 so'rov/s, xato 0%, p95 136–285 ms.
- Qabul sinovlari: 63 passed, 1 not_run (T-64, eski Telegram klienti).

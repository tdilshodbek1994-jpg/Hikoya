# Holat hisoboti — 2026-11-06

## Qisqacha
- **A bosqichi** (poydevor va vertikal oqim) va **B bosqichi** (birinchi to'liq reliz) kod darajasida tayyor.
- Tayyorlik avtomatik testlar va 360 px smoke testi bilan tekshirildi.
- **Hali qilinmagan:** haqiqiy bot tokeni bilan Telegram ichida sinov va haqiqiy Stars to'lovi. Yuklama testi bajarildi ([LOADTEST.md](LOADTEST.md)).
- C bosqichidan faqat bir qismi bor: audio pleyer, alohida asar xaridi, 90/365 kunlik paketlar. Qolgan C modullari yo'q, ularning tugmalari ham ko'rsatilmaydi (C bosqichi qoidasi).

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
| Deploy | Docker image'lar, docker-compose, Caddy HTTPS, `.env.example`, Makefile, backup/restore. Bu muhitda build va ishga tushirish sinaldi |

## Cheklovlar va ochiq savollar
1. **Telegram'da real sinov yo'q.** Bot tokeni va Telegram tarmog'i bo'lmagani uchun barcha Telegram chaqiruvlari soxta API bilan sinaldi. Deploydan keyingi tekshiruv ro'yxati quyida.
2. **Skrinshotlar.** Topshiriqdagi 5 ta YANGI.TV skrinshoti paketda yo'q edi. Dizayn matnli tavsif va berilgan ranglar asosida qilindi. Skrinshotlar yuborilsa, solishtirib moslashtiraman.
3. **RPO 15 daqiqa** uchun WAL arxivi kerak. Hozir faqat kunlik dump bor.
4. **Antivirus tekshiruvi yo'q.** Hozir fayl turi, hajm va zip limitlari tekshiriladi. ClamAV kabi skaner keyin qo'shiladi.
5. **Video davomiyligi** faqat botdan yuborilganda Telegram'dan olinadi. Ilova ichidan yuklangan videoda tekshirilmaydi.
6. **Rus tili:** UI matnlari alohida lug'atga ajratilgan. Rus tarjimasi hali qo'shilmagan.
7. **Redis ishlatilmaydi** (ataylab qilingan qaror, [ARCHITECTURE.md](ARCHITECTURE.md)). Rate limit jarayon ichida ishlaydi. Bir nechta API nusxasi ishga tushirilsa, Redis'ga ko'chirish kerak.
8. **Telegram storisiga ulashish** faqat imkoniyat mavjudligini aniqlash darajasida. Iqtibos uchun rasm generatsiyasi yo'q.

## Bajarilmagan (C bosqichi va kengaytmalar)
- AI (muallif yordamchisi, tabiiy tilda qidiruv, spoilersiz eslatma).
- Qahramonlar daftari, «Qayerda to'xtagandim?» eslatmalari (`recap_note` maydoni bor, UI yo'q).
- Sinov o'quvchilari, tarmoqlanuvchi hikoyalar, sovg'a Premium, muallif daromadi va payout.
- Matnning aniq joyiga sharh (inline), so'zma-so'z audio yoritish, PDF/EPUB/OCR import.

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
3. Keyin C bosqichidan siz tanlagan modullar: masalan audio kengaytmasi va muallif daromadi.

## Raqamlar
- Backend: 71 jadval, 132 API yo'li, 69 avtomatik test (unit + integratsiya, haqiqiy PostgreSQL).
- Frontend: 30+ ekran, o'quvchi bundle'i ~125 KB gzip, studio alohida lazy chunk.
- Smoke: 360 px, 18/18.
- Yuklama: 500 o'quvchi, ~100 so'rov/s, xato 0%, p95 136–285 ms.
- Qabul sinovlari: 60 passed, 1 qisman, 1 not_run, 2 n/a.

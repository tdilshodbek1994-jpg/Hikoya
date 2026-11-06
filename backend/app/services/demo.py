"""Original demo content written for this project. Every row is marked ``is_demo``.

No fake counters: likes, thanks, readers and TOP positions of demo works start at zero.
Remove with ``python -m app.cli demo-remove``.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import content_schema as cs
from app.core.text import normalize_for_search
from app.core.timeutil import utcnow
from app.models import AuthorProfile, AuthorStory, CuratedCollection, CuratedItem, Genre, StoryFrame, Tag, Work, WorkTag
from app.services import content as svc
from app.services.identity import Actor

AUTHORS = [
    ("Nilufar Sobirova", "Oilaviy va hayotiy hikoyalar yozadi. Kundalik voqealardagi kichik mo'jizalarni izlaydi."),
    ("Jasur Qodirov", "Detektiv va sirli voqealar ishqibozi. Har bir hikoyasi savol bilan boshlanadi."),
    ("Madina Rahimova", "Ertaklar va bolalar uchun hikoyalar muallifi."),
]

P = "\n\n"

WORKS: list[dict] = [
    {
        "title": "Choynakdagi tun",
        "author": 0,
        "genre": "oilaviy",
        "extra": ["hayotiy"],
        "mood": "tasirli",
        "format": "short",
        "completion": "completed",
        "policy": "FREE",
        "synopsis": "Qishning eng uzun kechasida buvisi bilan qolgan Dilshod eski choynak ichida saqlangan xatni topadi.",
        "featured": "Qisqa, iliq va oila haqida — kechki o'qish uchun.",
        "chapters": [
            ("Choynakdagi tun", P.join([
                "Qish o'sha yili erta keldi. Noyabrning o'rtasida hovlidagi o'rik shoxlari qor ostida egilib, tomdan tushgan muz parchalari tunda chirsillab sinardi. Dilshodning ota-onasi shaharga, xolasining to'yiga ketgan, u esa buvisi bilan qolgan edi.",
                "Buvisi kechqurun sandal atrofiga ko'rpa yozdi, ustiga eski dasturxonni tashladi. «Choy qo'yib kel, bolam», dedi u. Dilshod oshxonaga chiqib, javonning eng yuqorisidagi ko'k gulli choynakni oldi. Bu choynakdan hech kim choy ichmasdi — u faqat bayramlarda stol bezagi bo'lib turardi.",
                "Choynakni yuvayotganda ichida nimadir shitirladi. Dilshod qopqog'ini ochib, ehtiyotkorlik bilan barmoqlarini tiqdi va sarg'ayib ketgan, to'rt buklangan qog'ozni chiqarib oldi. Qog'oz chetiga qalam bilan «Saodatga» deb yozilgan edi. Saodat — buvisining ismi.",
                "U xatni qo'lida ushlab, uzoq turdi. Ochishga botinmadi. Sandal yoniga qaytib, buvisiga uzatdi. Kampir ko'zoynagini taqib, qog'ozga qaradi-yu, birdan jim bo'lib qoldi. Keyin sekin kulimsiradi.",
                "«Buni bobong yozgan», dedi u. «Biz to'y qilgan yili. Men o'shanda bu choynakni sotib olgan edim, bobong esa ichiga xat solib, men ko'rmay qo'yibdi. Ellik yil... Ellik yil ichida bir marta ham qopqog'ini ochmabman».",
                "Dilshod buvisining ovozi titrayotganini sezdi. «O'qib bering», dedi u past ovozda. Buvisi xatni ochdi. Unda bor-yo'g'i uch qator bor edi: «Bu choynakdan birinchi choyni men quyaman. Har qishda shunday qilaman. Agar bir kun qila olmasam, bu xat o'rnimga quysin».",
                "Uyda bir muddat faqat pechkaning g'ijirlashi eshitildi. Keyin buvisi o'rnidan turdi, choynakni olib, unga choy damladi. Ikki piyolani to'ldirdi. Biri o'ziga, biri Dilshodga. Uchinchi piyolani bo'sh qo'yib, yonidagi joyga surib qo'ydi.",
                "«Bobong har doim shunday qilardi», dedi u. «Choyni avval menga quyardi, keyin o'ziga. Endi bu ish senga qoldi». Dilshod choynakni qo'liga oldi. U og'ir edi — choyidan emas, ellik yillik qishlardan og'irroq edi.",
                "O'sha tun ular uzoq gaplashdi. Buvisi bobosining qanday qilib uni qo'shni mahalladan uch yil kuzatib yurganini, bir kuni bozorda shu choynakni ko'tarib berishga yordam berib, gapni boshlaganini aytib berdi. Dilshod bu voqeani birinchi marta eshitayotgan edi.",
                "Ertalab qor tingan, hovli oppoq edi. Dilshod uyg'onganda buvisi allaqachon turib, ko'k gulli choynakni stol o'rtasiga qo'ygan edi. Endi u bayram bezagi emas, har kungi choynakka aylangandi. Xat esa yana uning ichida — keyingi kim topishini kutib yotardi.",
            ])),
        ],
    },
    {
        "title": "Yettinchi qavatdagi chiroq",
        "author": 1,
        "genre": "detektiv",
        "extra": ["mistika"],
        "mood": "sarguzashtli",
        "format": "novella",
        "completion": "ongoing",
        "policy": "PREMIUM",
        "free_first": True,
        "synopsis": "Har kecha soat ikkida bo'sh turgan kvartirada chiroq yonadi. Tergovchi Komil buni tasodif deb hisoblamaydi.",
        "featured": "Premium detektiv: birinchi bob bepul.",
        "chapters": [
            ("1-bob. Bo'sh kvartira", P.join([
                "Komil derazadan qarab turib sigaretini tashlaganiga uch yil bo'lganini esladi. Odat qolgan edi — kechasi ishdan qaytib, oshxona chirog'ini yoqmay, qorong'ida qarshidagi binoga tikilib turish.",
                "Qarshidagi to'qqiz qavatli uyning yettinchi qavatida bitta deraza bor edi. U yerda hech kim yashamasdi. Uy boshqaruvchisining aytishicha, kvartira egasi ikki yil oldin chet elga ketgan, kalitni hech kimga qoldirmagan.",
                "Ammo har kecha, roppa-rosa soat ikkida, o'sha derazada sariq chiroq yonardi. Besh daqiqa. Keyin o'chardi. Komil buni bir haftadan beri kuzatayotgan edi va har safar soatiga qarab, vaqtni daftariga yozib qo'yardi.",
                "Sakkizinchi kechasi chiroq yonmadi. Komil soat ikkidan o'tib, uchgacha kutdi. Deraza qorong'i edi. U daftarini yopdi-yu, birdan qo'li to'xtadi: qarshidagi binoning kirish eshigi ochilib, kimdir chiqib ketdi. Qo'lida katta sumka bor edi.",
                "Ertasi kuni Komil uy boshqaruvchisini topdi. Kvartiraga birga kirishga ruxsat so'radi. Boshqaruvchi avval rozi bo'lmadi, keyin guvohnomani ko'rib, kalitlar to'plamini olib chiqdi. «Zaxira kalit bor ekan», dedi u o'zi ham hayron bo'lib.",
                "Kvartirada chang hidi bor edi. Mebellar oq choyshab bilan yopilgan, oshxonada muzlatgich o'chirilgan. Komil yotoqxonaga kirdi. Deraza oldida stol, stol ustida esa eski, temir oyoqli chiroq turardi. Chiroq vilkasi rozetkaga ulangan, simiga esa kichkina taymer o'rnatilgan edi.",
                "Taymer soat 02:00 ga qo'yilgan. Lekin taymer yonida, chang bosgan stol ustida, toza joy bor edi — kimdir yaqinda u yerda nimadir qo'yib, keyin olib ketgan. To'rtburchak shakl. Kitobmi, qutimi.",
                "Komil telefonini olib, toza joyni suratga oldi. Keyin taymerga qaradi. Uning orqa tomonida kichkina qog'oz yopishtirilgan edi, unda bitta raqam: 7. Komil kvartira raqamiga qaradi. Bu 43-kvartira edi.",
                "«Yettinchi qavat, yettinchi raqam», dedi u ovoz chiqarib. Boshqaruvchi yelka qisdi. Komil esa deraza oldiga borib, qarshidagi binoga — o'zining uyiga qaradi. Uning oshxona derazasi aynan shu yerdan, aniq ko'rinib turardi.",
                "Shunda u tushundi: chiroq kimgadir belgi bo'lmagan. Chiroq uning o'zi uchun yongan. Kimdir uni bir haftadan beri kuzatib, unga nimadir aytmoqchi bo'lgan. Va kechagi tunda bu gap tugagan edi.",
            ])),
            ("2-bob. Raqamlar", P.join([
                "Bo'limga qaytgach, Komil arxivdan so'nggi bir yildagi yopilmagan ishlarni so'radi. Yettinchi raqam bilan bog'liq narsa izladi. Kotiba Lola qalin papkalarni stolga qo'yib, kinoya bilan kulimsiradi: «Raqamli jumboqmi? Kino ko'p ko'ryapsiz».",
                "Uchinchi papkada u to'xtadi. Yetti oy oldingi o'g'irlik: shahar kutubxonasidan noyob qo'lyozma yo'qolgan. Ish yopilmagan, guvohlar yo'q. Qo'lyozmaning o'lchami esa — to'rtburchak, kichik kitob hajmida.",
                "Komil chang bosgan stoldagi toza joyning suratini kattalashtirdi. O'lchamlar mos keldi. Lekin nega kimdir o'g'irlangan qo'lyozmani bo'sh kvartirada saqlagan va nega bunga tergovchining e'tiborini tortgan?",
                "Kutubxona direktori keksa, ozg'in odam edi. U Komilni ko'rib avval xursand bo'ldi, keyin savollar boshlanganda ko'zlarini olib qochdi. «Qo'lyozma qimmatli edi, albatta. Lekin uning asl qiymatini faqat bir kishi bilardi», dedi u.",
                "«Kim?» — so'radi Komil. Direktor uzoq jim turdi. Keyin derazaga qarab, sekin javob berdi: «Uni topgan odam. Ikki yil oldin chet elga ketgan. Uyi qarshingizdagi binoda, yettinchi qavatda».",
                "Komilning orqasidan sovuq o'tdi. Demak, kvartira egasi ketmagan. Yoki ketgan-u, qaytib kelgan. Yoki kimdir uning nomidan harakat qilyapti. Va bu kimdir Komil haqida ko'p narsa biladi — hatto qaysi derazadan qarashini ham.",
                "Kechasi u yana oshxonada, qorong'ida turdi. Soat ikki bo'ldi. Qarshidagi deraza qorong'i edi. Lekin pastda, uning o'z binosi kirish eshigi oldida, kichik bir quti turardi. Ustida bitta raqam: 8.",
            ])),
        ],
    },
    {
        "title": "Bulutni tutgan qiz",
        "author": 2,
        "genre": "bolalar",
        "extra": ["fentezi"],
        "mood": "yengil",
        "format": "short",
        "completion": "completed",
        "policy": "FREE",
        "synopsis": "Kichkina Zulfiya osmondagi eng kichik bulutni do'st qilib oladi. Ammo bulutlar bir joyda turolmaydi.",
        "chapters": [
            ("Bulutni tutgan qiz", P.join([
                "Bir bor ekan, bir yo'q ekan, tog' etagidagi qishloqda Zulfiya degan qiz yashar ekan. U har kuni tomga chiqib, osmondagi bulutlarni sanarkan. Katta bulutlar tuyaga, o'rtachalari qo'ylarga o'xshar, eng kichigi esa paxtaning bir bo'lagidek kichkina ekan.",
                "Bir kuni o'sha eng kichik bulut boshqalardan orqada qolib ketibdi. Shamol katta bulutlarni tog' ortiga haydab ketgan, kichigi esa Zulfiyaning tomi ustida yolg'iz suzib yuraveribdi. Qiz unga qo'l silkibdi. Bulut ham, go'yo javob bergandek, biroz pastroq tushibdi.",
                "«Sen ham yolg'izmisan?» — so'rabdi Zulfiya. Bulut jimgina yana pastlabdi va qizning boshi ustida, xuddi soyabon kabi to'xtabdi. O'sha kuni quyosh juda qattiq qizdirayotgan ekan, Zulfiya esa salqin soyada o'ynabdi.",
                "Ertasi kuni ham bulut keldi. Indiniga ham. Zulfiya uni Paxtaxon deb atabdi. Ular birga bog'ga borishar, Paxtaxon gullarga mayda tomchilar sepib, qizni kuldirarkan. Qishloq bolalari hayron qolishibdi: nega faqat Zulfiyaning boshida bulut bor?",
                "Kunlar o'tibdi. Bir kuni Paxtaxon kelmabdi. Zulfiya tomda kun bo'yi kutibdi. Kechqurun bobosi yoniga chiqib, uning yelkasiga qo'lini qo'yibdi. «Bulutlar bir joyda turolmaydi, qizim», debdi u. «Ularning ishi — uzoq-uzoqlarga yomg'ir olib borish».",
                "Zulfiya yig'lab yuboribdi. Ammo shu payt tog' ortidan sekin, juda sekin, kichkina bir bulut chiqib kelibdi. U avvalgidan biroz kattaroq ekan. Bulut tom ustiga kelib, bir lahza to'xtabdi-yu, qizning yuziga ikki tomchi tashlabdi — xuddi xayrlashgandek.",
                "Shundan keyin Zulfiya bulutlarni sanamay qo'yibdi. U endi har bir yomg'irda Paxtaxonni eslar ekan. Chunki bilarkan: qayerdadir, uzoq bir dalada uning do'sti kimgadir soya va suv olib bormoqda.",
            ])),
        ],
    },
    {
        "title": "Ikkinchi imkon",
        "author": 0,
        "genre": "ibratli",
        "extra": ["ruhiy-psixologik"],
        "mood": "oylantiruvchi",
        "format": "short",
        "completion": "completed",
        "policy": "PREMIUM",
        "synopsis": "Bir xato butun hayotni o'zgartirishi mumkin. Yo'l ustidagi kichik do'kon egasi bunga ishonmaydi.",
        "chapters": [
            ("Ikkinchi imkon", P.join([
                "Rustam aka do'konini har kuni soat yettida ochardi. Kichkina do'kon edi: non, sut, gugurt, bolalar uchun bir nechta shirinlik. Mijozlarning ko'pchiligi qo'shnilar edi, ularning ismini, hatto qarzlarini ham yoddan bilardi.",
                "O'sha kuni ertalab eshik oldida o'smir bola turardi. Kiyimi kir, ko'zlari uyqusiz. U ichkariga kirib, javonlarni ko'zdan kechirdi, keyin tez qo'lini cho'ntagiga tiqib, eshik tomon yurdi. Rustam aka uning qo'lidagi nonni ko'rdi.",
                "«Bolam», dedi u ovozini ko'tarmay. Bola to'xtadi, orqasiga o'girilmadi. Yelkalari qisilib, qochishga tayyorlandi. «Bitta non bilan to'ymaysan. Kel, choy ham ich», dedi Rustam aka va peshtaxta ortidagi kichkina stolchaga ishora qildi.",
                "Bola ishonmay qaradi. Keyin sekin qaytib keldi. Rustam aka unga choy quydi, non yoniga bir bo'lak pishloq qo'ydi. Bola indamay yedi. Ovqat tugagach, u birinchi marta gapirdi: «Pulim yo'q. Keyin ham bo'lmaydi».",
                "«Bilaman», dedi Rustam aka. «Ertaga soat yettida kel. Qutilarni tashishga yordam berasan. Keyin choy ichamiz». Bola hech narsa demay chiqib ketdi. Rustam aka uni boshqa ko'rmayman deb o'yladi.",
                "Ammo ertasi kuni soat yettiga besh daqiqa qolganda bola eshik oldida turardi. Indiniga ham. Bir oydan keyin u kassada o'tirar, qo'shnilarning ismlarini ham, qarzlarini ham yoddan bilardi.",
                "Yillar o'tdi. Rustam aka qarib, do'konni yopishga qaror qildi. Oxirgi kuni eshik oldiga qora mashina kelib to'xtadi. Undan kostyum kiygan yigit tushdi. Qo'lida kichkina qog'oz xalta, ichida — bitta non.",
                "«Qarzimni to'lashga keldim», dedi u kulib. Rustam aka uni tanidi. Yigit do'konni sotib olmoqchi ekanini, uni yopmasdan, xuddi avvalgidek, soat yettida ochishini aytdi. «Faqat bir shart bilan», dedi u. «Peshtaxta ortidagi stolcha joyida qolsin. Kimgadir kerak bo'ladi».",
            ])),
        ],
    },
    {
        "title": "Карвонсарой сири",
        "author": 1,
        "genre": "tarixiy",
        "extra": ["sarguzasht"],
        "mood": "sarguzashtli",
        "format": "short",
        "completion": "completed",
        "policy": "FREE",
        "script": "cyrl",
        "synopsis": "Буюк Ипак йўлидаги карвонсаройда бир кечада йўқолган савдогар ҳақида ҳикоя.",
        "chapters": [
            ("Карвонсарой сири", P.join([
                "Карвонсарой дарвозаси қуёш ботиши билан ёпиларди. Ўша кеча ҳам шундай бўлди: охирги туя ичкарига кирди, қоровул оғир занжирни туширди ва ҳовлида гулханлар ёнди.",
                "Савдогар Бобур дарвоза ёнидаги ҳужрада тунади. У Самарқанддан ипак олиб келаётган эди. Эрталаб унинг ҳужраси бўш эди: на ўзи, на юклари. Фақат деворда кўмир билан чизилган кичкина ой расми қолган.",
                "Карвонсарой эгаси Ҳайдар бобо ҳаммани ҳовлига йиғди. Дарвоза кечаси очилмаган, деворлар баланд эди. Демак, Бобур ҳали ҳам шу ерда ёки бу ердан бошқа йўл билан чиқиб кетган.",
                "Ёш хизматкор Анвар деворидаги ойга узоқ тикилди. У бу белгини аввал ҳам кўрган эди — қудуқ тошида. Кечаси, ҳамма ухлаганда, у қудуққа тушди. Сув сатҳидан пастроқда тор йўлак бошланарди.",
                "Йўлак шаҳар ташқарисидаги эски тегирмонга олиб чиқди. У ерда Бобур ўтирарди, ёнида юклари. У Анварни кўриб кулди: «Мени қароқчилардан қутқарган шу йўлак. Улар карвонни йўлда кутиб туришган эди».",
                "Эрталаб Бобур карвонсаройга бошқа дарвозадан қайтди. Қароқчилар эса бўш йўлда ҳеч нарса топмай тарқалишди. Ҳайдар бобо Анварни чақириб, қудуқ сирини ҳеч кимга айтмасликни сўради. Анвар ваъда берди ва уни умрининг охиригача сақлади.",
            ])),
        ],
    },
    {
        "title": "Sakkiz daqiqa",
        "author": 0,
        "genre": "sevgi",
        "extra": ["hayotiy"],
        "mood": "tasirli",
        "format": "short",
        "completion": "completed",
        "policy": "FREE",
        "synopsis": "Har kuni ertalab metroda sakkiz daqiqa birga ketadigan ikki notanish.",
        "chapters": [
            ("Sakkiz daqiqa", P.join([
                "Metro bekatidan keyingi bekatgacha roppa-rosa sakkiz daqiqa. Shahnoza buni bilardi, chunki har kuni shu vaqtni o'qishga ishlatardi: kitobning taxminan to'rt sahifasi.",
                "Qarshisidagi o'rindiqda har kuni bir yigit o'tirardi. U ham kitob o'qirdi. Bir kuni Shahnoza ularning kitobi bir xil ekanini payqadi. Yigit undan ikki bob oldinda edi.",
                "Ertasi kuni u biroz tezroq o'qidi. Yigit ham. Bir haftadan keyin ular bir sahifaga yetdi. Shahnoza kitobdan ko'zini olib, unga qaradi. Yigit ham qaradi. Ikkalasi ham kulib yubordi.",
                "«Oxirini aytmang», dedi Shahnoza. «Aytmayman», dedi yigit. «Lekin ertaga sakkiz daqiqa yetmaydi. Oxirgi bob uzun». Shahnoza bir lahza o'ylanib qoldi. «Unda keyingi bekatda tushib, qolganini kafeda o'qiymiz».",
                "Ular kitobni bir vaqtda tugatishdi. Shundan keyin ham har kuni ertalab sakkiz daqiqa birga ketishdi. Faqat endi kitobni bitta qilib, birga o'qishardi.",
            ])),
        ],
    },
]

STORY_FRAMES = [
    (1, [{"kind": "text", "text": "Yangi bob tayyor: «Raqamlar». Sakkizinchi qutida nima bor?", "background": "night"}]),
    (0, [{"kind": "quote", "text": "«Bu choynakdan birinchi choyni men quyaman. Har qishda shunday qilaman.»", "background": "gold"}]),
    (2, [{"kind": "poll", "text": "Keyingi ertak qaysi qahramon haqida bo'lsin?", "poll_options": ["Shamol", "Yulduz", "Daryo"], "background": "violet"}]),
]


async def seed_demo(db: AsyncSession, actor: Actor) -> dict:
    """Create demo authors, works, storis and editorial picks. Idempotent by title."""
    created = 0
    authors: list[AuthorProfile] = []
    for name, bio in AUTHORS:
        a = await db.scalar(select(AuthorProfile).where(AuthorProfile.pen_name == name, AuthorProfile.is_demo.is_(True)))
        if a is None:
            from app.core.text import slugify

            a = AuthorProfile(pen_name=name, slug=f"demo-{slugify(name)}", bio=bio, is_demo=True, search_text=normalize_for_search(name), editorial_featured=True, publish_policy="trusted")
            db.add(a)
            await db.flush()
        authors.append(a)
    genres = {g.slug: g.id for g in (await db.scalars(select(Genre))).all()}
    tags = {t.slug: t.id for t in (await db.scalars(select(Tag))).all()}
    coll = await db.scalar(select(CuratedCollection).where(CuratedCollection.slug == "editors-choice"))
    works_by_idx: dict[int, Work] = {}
    for i, spec in enumerate(WORKS):
        existing = await db.scalar(select(Work).where(Work.title == spec["title"], Work.is_demo.is_(True)))
        if existing:
            works_by_idx[i] = existing
            continue
        w = await svc.create_work(
            db,
            actor,
            title=spec["title"],
            synopsis=spec["synopsis"],
            author_id=authors[spec["author"]].id,
            format=spec["format"],
            script=spec.get("script", "latn"),
            completion_state=spec["completion"],
            primary_genre_id=genres[spec["genre"]],
            genre_ids=[genres[g] for g in spec.get("extra", [])],
            tag_ids=[tags[spec["mood"]]] if spec.get("mood") in tags else [],
            access_policy=spec["policy"],
            is_demo=True,
        )
        for j, (title, text) in enumerate(spec["chapters"]):
            ch = await svc.add_chapter(db, actor, w, title=title, doc=cs.text_to_doc(text, markdown=False), access_override="free_sample" if spec.get("free_first") and j == 0 else "inherit")
            ch.preview_blocks = 3
        await svc.publish_now(db, actor, w)
        if spec.get("featured") and coll:
            db.add(CuratedItem(collection_id=coll.id, work_id=w.id, reason=spec["featured"], sort_key=i))
        works_by_idx[i] = w
        created += 1
    if not await db.scalar(select(AuthorStory.id).where(AuthorStory.author_id.in_([a.id for a in authors])).limit(1)):
        now = utcnow()
        for ai, frames in STORY_FRAMES:
            st = AuthorStory(author_id=authors[ai].id, caption="demo", status="published", publish_at=now, expires_at=now + timedelta(hours=24), duration_hours=24, created_by=actor.id)
            db.add(st)
            await db.flush()
            for k, f in enumerate(frames):
                linked = works_by_idx.get(1) if ai == 1 else (works_by_idx.get(0) if ai == 0 else None)
                db.add(StoryFrame(story_id=st.id, sort_key=k, kind=f["kind"], text=f["text"], background=f["background"], poll_options=f.get("poll_options", []), action_type="vote" if f["kind"] == "poll" else ("read" if linked else ""), linked_work_id=linked.id if linked else None, duration_ms=8000))
    await db.flush()
    return {"created_works": created, "authors": len(authors)}


async def remove_demo(db: AsyncSession) -> dict:
    ids = (await db.scalars(select(Work.id).where(Work.is_demo.is_(True)))).all()
    await db.execute(delete(WorkTag).where(WorkTag.work_id.in_(ids or [0])))
    await db.execute(delete(Work).where(Work.id.in_(ids or [0])))
    aids = (await db.scalars(select(AuthorProfile.id).where(AuthorProfile.is_demo.is_(True)))).all()
    await db.execute(delete(AuthorStory).where(AuthorStory.author_id.in_(aids or [0])))
    await db.execute(delete(AuthorProfile).where(AuthorProfile.id.in_(aids or [0])))
    return {"removed_works": len(ids), "removed_authors": len(aids)}

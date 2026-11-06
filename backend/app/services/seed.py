"""Reference data (genres, tags, home layout, products) and clearly-marked demo content."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.text import lat_to_cyr
from app.models import CuratedCollection, Genre, HomeSection, Product, ProductVersion, Tag

GENRES = [
    ("hayotiy", "Hayotiy", "🌿", ["hayot", "real"]),
    ("sevgi", "Sevgi", "💜", ["muhabbat", "romantika"]),
    ("oilaviy", "Oilaviy", "🏡", ["oila"]),
    ("ibratli", "Ibratli", "💡", ["ibrat", "saboq"]),
    ("ruhiy-psixologik", "Ruhiy-psixologik", "🧠", ["psixologik"]),
    ("drama", "Drama", "🎭", []),
    ("detektiv", "Detektiv", "🔍", ["jinoyat", "tergov"]),
    ("triller", "Triller", "⚡", []),
    ("sarguzasht", "Sarguzasht", "🧭", ["sayohat"]),
    ("tarixiy", "Tarixiy", "🏛", ["tarix"]),
    ("fantastika", "Fantastika", "🚀", ["ilmiy fantastika"]),
    ("fentezi", "Fentezi", "🐉", ["fantasy"]),
    ("mistika", "Mistika", "🌒", ["sirli"]),
    ("hajviy", "Hajviy", "😄", ["kulgili", "yumor"]),
    ("bolalar", "Bolalar va ertaklar", "🧸", ["ertak", "bolalar"]),
]

MOODS = [("tasirli", "Ta'sirli"), ("yengil", "Yengil"), ("oylantiruvchi", "O'ylantiruvchi"), ("sarguzashtli", "Sarguzashtli")]

HOME = [
    ("stories", "stories", "Mualliflar storisi", {}),
    ("genres", "genres", "Janrlar", {}),
    ("continue", "continue", "Davom ettirish", {}),
    ("editorial", "editorial", "Muharrir tavsiyasi", {"collection": "editors-choice"}),
    ("top", "top", "Eng ko'p o'qilgan TOP-10", {"period": "week"}),
    ("for_you", "for_you", "Siz uchun", {}),
    ("new_chapters", "new_chapters", "Yangi boblar", {}),
    ("premium", "premium", "Premium hikoyalar", {}),
    ("new", "rail", "Yangi qo'shilgan", {"sort": "new"}),
    ("completed", "rail", "Tugallangan", {"status": "completed", "sort": "new"}),
    ("short", "rail", "5–15 daqiqalik", {"min_minutes": 5, "max_minutes": 15, "sort": "new"}),
    ("thanks", "rail", "Eng ko'p rahmat olgan", {"sort": "thanks"}),
    ("new_authors", "rail", "Yangi mualliflar", {"new_authors": True, "sort": "new"}),
    ("audio", "rail", "Audio mavjud", {"has_audio": True, "sort": "new"}),
]


async def seed_reference(db: AsyncSession) -> None:
    if not await db.scalar(select(Genre.id).limit(1)):
        for i, (slug, name, emoji, syn) in enumerate(GENRES):
            db.add(Genre(slug=slug, name_latn=name, name_cyrl=lat_to_cyr(name), emoji=emoji, synonyms=syn, sort_order=i * 10))
    if not await db.scalar(select(Tag.id).limit(1)):
        for slug, name in MOODS:
            db.add(Tag(slug=slug, name_latn=name, name_cyrl=lat_to_cyr(name), kind="mood"))
    if not await db.scalar(select(HomeSection.id).limit(1)):
        for i, (key, kind, title, f) in enumerate(HOME):
            db.add(HomeSection(key=key, kind=kind, title_latn=title, title_cyrl=lat_to_cyr(title), sort_order=i * 10, filter=f, max_items=10 if kind == "top" else 12))
    if not await db.scalar(select(CuratedCollection.id).limit(1)):
        db.add(CuratedCollection(slug="editors-choice", title="Muharrir tavsiyasi", description="Tahririyat qo'lda tanlagan asarlar"))
    if not await db.scalar(select(Product.id).limit(1)):
        # Demo prices are shown as «demo» and can never be paid (is_demo). The owner sets a real price
        # with /price or the admin API; that creates a new non-demo version. 90/365-day packages stay off.
        p1 = Product(sku="premium_30d", title="HIKOYA PRO Premium — 30 kun", description="Premium katalogdagi barcha asarlar. Har 30 kunda yangilanadi.", access_scope="premium", pricing_type="subscription", active=True, sort_order=0)
        p2 = Product(sku="premium_90d", title="Premium — 90 kun (bir martalik)", description="90 kunlik bir martalik paket, avtomatik yangilanmaydi.", access_scope="premium", pricing_type="one_time", active=False, sort_order=1)
        p3 = Product(sku="premium_365d", title="Premium — 365 kun (bir martalik)", description="365 kunlik bir martalik paket, avtomatik yangilanmaydi.", access_scope="premium", pricing_type="one_time", active=False, sort_order=2)
        db.add_all([p1, p2, p3])
        await db.flush()
        db.add_all(
            [
                ProductVersion(product_id=p1.id, version=1, amount=150, duration_days=30, active=True, is_demo=True),
                ProductVersion(product_id=p2.id, version=1, amount=400, duration_days=90, active=True, is_demo=True),
                ProductVersion(product_id=p3.id, version=1, amount=1400, duration_days=365, active=True, is_demo=True),
            ]
        )
    await db.flush()

"""Quote cards: a 1080×1920 PNG with a short fragment of a chapter, for Telegram shareToStory.

Only a fragment the reader can actually read is accepted (full access to the chapter, the text
must be inside one block of the published revision, at most ``share_quote_max_chars``).
The card carries the work title, author and a deep link, never more text than the quote.
"""

from __future__ import annotations

import hashlib
import io
import os
import textwrap
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core import content_schema as cs
from app.core.errors import AccessRequired, Invalid, NotFound
from app.core.text import clean_plain
from app.integrations.storage import get_storage
from app.models import AuthorProfile, Chapter, ChapterRevision, Work
from app.services.access import Entitlements, decide_chapter_access

W, H = 1080, 1920
# bundled DejaVu fonts (free licence, app/assets/fonts/LICENSE-DejaVu.txt): no apt package needed
FONT_DIRS = (os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "fonts"), "/usr/share/fonts/truetype/dejavu")
THEMES = {
    "paper": ((246, 240, 228), (40, 34, 28), (150, 110, 70)),
    "night": ((24, 26, 34), (236, 232, 222), (210, 170, 110)),
    "rose": ((250, 230, 232), (60, 30, 40), (180, 80, 100)),
}


@lru_cache
def _font(name: str, size: int):
    from PIL import ImageFont

    for d in FONT_DIRS:
        try:
            return ImageFont.truetype(f"{d}/{name}", size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _norm(s: str) -> str:
    return " ".join(s.replace("«", '"').replace("»", '"').replace("“", '"').replace("”", '"').split())


def render_card(quote: str, title: str, author: str, theme: str = "paper") -> bytes:
    from PIL import Image, ImageDraw

    bg, fg, accent = THEMES.get(theme, THEMES["paper"])
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    d.rectangle((80, 80, W - 80, H - 80), outline=accent, width=4)
    size = 64 if len(quote) < 90 else 54 if len(quote) < 150 else 46
    font = _font("DejaVuSerif.ttf", size)
    width_chars = int(860 / (size * 0.52))
    lines = textwrap.wrap(f"«{quote}»", width=width_chars)[:14]
    line_h = int(size * 1.45)
    y = (H - line_h * len(lines)) // 2 - 120
    d.text((W // 2, y - 90), "“", font=_font("DejaVuSerif-Bold.ttf", 180), fill=accent, anchor="mm")
    for ln in lines:
        d.text((W // 2, y), ln, font=font, fill=fg, anchor="ma")
        y += line_h
    y += 80
    d.line((W // 2 - 80, y, W // 2 + 80, y), fill=accent, width=3)
    d.text((W // 2, y + 50), title[:60], font=_font("DejaVuSerif-Bold.ttf", 46), fill=fg, anchor="ma")
    d.text((W // 2, y + 120), author[:60], font=_font("DejaVuSans.ttf", 38), fill=accent, anchor="ma")
    s = get_settings()
    d.text((W // 2, H - 170), f"t.me/{s.bot_username}", font=_font("DejaVuSans.ttf", 36), fill=accent, anchor="ma")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


async def check_quote_in_chapter(db: AsyncSession, chapter: Chapter, block_id: str, quote: str) -> None:
    """The fragment must be inside one block of the PUBLISHED revision (no draft or invented text)."""
    rev = await db.get(ChapterRevision, chapter.published_revision_id) if chapter.published_revision_id else None
    block = next((b for b in rev.content_json.get("content", []) if (b.get("attrs") or {}).get("bid") == block_id), None) if rev else None
    if block is None or not _norm(quote) or _norm(quote) not in _norm(cs.block_text(block)):
        raise Invalid("Iqtibos bob matnidan olinmagan", code="quote_mismatch")


async def quote_card(db: AsyncSession, ent: Entitlements, chapter_id: int, block_id: str, text: str, theme: str = "paper") -> dict:
    s = get_settings()
    chapter = await db.get(Chapter, chapter_id)
    if chapter is None or chapter.is_deleted or not chapter.published_revision_id:
        raise NotFound("Bob topilmadi")
    work = await db.get(Work, chapter.work_id)
    if work is None or work.visibility == "hidden":
        raise NotFound("Bob topilmadi")
    if not decide_chapter_access(work, chapter, ent).full:
        raise AccessRequired("Iqtibos uchun bobni o'qish huquqi kerak", code="access_required")
    quote = clean_plain(text)
    if not quote:
        raise Invalid("Iqtibos bo'sh", code="empty")
    if len(quote) > s.share_quote_max_chars:
        raise Invalid(f"Iqtibos {s.share_quote_max_chars} belgidan oshmasin", code="quote_too_long")
    await check_quote_in_chapter(db, chapter, block_id, quote)
    author = await db.get(AuthorProfile, work.primary_author_id)
    theme = theme if theme in THEMES else "paper"
    key = "quotes/" + hashlib.sha256(f"{chapter.published_revision_id}:{block_id}:{quote}:{theme}".encode()).hexdigest()[:40] + ".png"
    png = render_card(quote, work.title, author.pen_name if author else "", theme)
    await get_storage().put(key, png, "image/png", True)
    link = f"https://t.me/{s.bot_username}/{s.miniapp_short_name}?startapp=c_{chapter.id}"
    return {"image_url": get_storage().public_url(key), "link": link, "text": f"«{quote}» — {work.title}", "width": W, "height": H}

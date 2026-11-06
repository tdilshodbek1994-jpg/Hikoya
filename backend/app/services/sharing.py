"""Sharing that looks good in Telegram and is measurable.

* every share has an id that travels in the deep link: ``w_<code>__s<id>``;
* «message» shares use Bot API 8.0 ``savePreparedInlineMessage`` + ``WebApp.shareMessage``:
  the friend receives a card (cover, title, author) with a «📖 O'qish» button that opens the Mini App;
* inline mode: ``@bot <words>`` in any chat lists works as cards;
* «story» shares get a 1080×1920 card for ``shareToStory``;
* opens are counted once per person; a brand-new user who came through a share is also bound
  to the sharer as a referral (same reward rules as invite links).
Only public, catalog-visible works can be shared as cards; nothing behind a paywall is put on the card.
"""

from __future__ import annotations

import hashlib
import io
import re
import textwrap
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import NotFound
from app.core.text import minutes_for_words
from app.core.timeutil import utcnow
from app.integrations.storage import get_storage
from app.integrations.telegram import TelegramError, TelegramUncertain, get_telegram
from app.models import Asset, AuthorProfile, Chapter, Genre, ShareLink, ShareOpen, User, Work
from app.services.quotes import _font

SHARE_RE = re.compile(r"__s(\d{1,12})$")
CHANNELS = {"message", "story", "link", "inline", "native"}
BG, FG, ACCENT, MUTED = (16, 18, 26), (240, 236, 228), (214, 182, 106), (150, 150, 165)


def split_param(param: str) -> tuple[str, int | None]:
    """'w_abc__s12' → ('w_abc', 12)."""
    m = SHARE_RE.search(param or "")
    if not m:
        return param, None
    return param[: m.start()], int(m.group(1))


def app_link(param: str) -> str:
    s = get_settings()
    return f"https://t.me/{s.bot_username}/{s.miniapp_short_name}" + (f"?startapp={param}" if param else "")


# ------------------------------------------------------------------ cards


async def _cover_image(db: AsyncSession, work: Work):
    from PIL import Image

    if not work.cover_asset_id:
        return None
    a = await db.get(Asset, work.cover_asset_id)
    if a is None or a.kind != "image":
        return None
    try:
        data = await get_storage().get(a.storage_key, a.visibility == "public")
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:  # noqa: BLE001 — a broken cover must not break sharing
        return None


def _rounded(img, radius: int):
    from PIL import Image, ImageDraw

    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), radius=radius, fill=255)
    out = Image.new("RGBA", img.size)
    out.paste(img, (0, 0), mask)
    return out


def render_work_card(cover, title: str, author: str, meta: str, story: bool) -> bytes:
    """JPEG card. 1080×1350 for chats (Telegram photo results need JPEG), 1080×1920 for stories."""
    from PIL import Image, ImageDraw, ImageFilter

    W, H = (1080, 1920) if story else (1080, 1350)
    img = Image.new("RGB", (W, H), BG)
    if cover is not None:
        # blurred cover as a soft background, darkened for legible text
        bg = cover.copy()
        bg.thumbnail((W // 4, H // 4))
        bg = bg.resize((W, H)).filter(ImageFilter.GaussianBlur(18))
        img = Image.blend(img, bg, 0.35)
    d = ImageDraw.Draw(img)
    cw, ch = (620, 930) if story else (440, 660)
    top = 250 if story else 100
    if cover is not None:
        c = cover.copy()
        ratio = max(cw / c.width, ch / c.height)
        c = c.resize((int(c.width * ratio), int(c.height * ratio)))
        left, upper = (c.width - cw) // 2, (c.height - ch) // 2
        c = _rounded(c.crop((left, upper, left + cw, upper + ch)), 28)
        img.paste(c, ((W - cw) // 2, top), c)
    else:
        d.rounded_rectangle(((W - cw) // 2, top, (W + cw) // 2, top + ch), radius=28, fill=(44, 40, 70))
        y0 = top + ch // 2 - 60
        for ln in textwrap.wrap(title, 14)[:3]:
            d.text((W // 2, y0), ln, font=_font("DejaVuSerif-Bold.ttf", 52), fill=FG, anchor="ma")
            y0 += 66
    y = top + ch + (90 if story else 60)
    tsize = 64 if len(title) < 24 else 52
    for ln in textwrap.wrap(title, int(900 / (tsize * 0.55)))[:2]:
        d.text((W // 2, y), ln, font=_font("DejaVuSerif-Bold.ttf", tsize), fill=FG, anchor="ma")
        y += int(tsize * 1.25)
    d.text((W // 2, y + 10), author[:50], font=_font("DejaVuSans.ttf", 40), fill=ACCENT, anchor="ma")
    d.text((W // 2, y + 70), meta[:60], font=_font("DejaVuSans.ttf", 32), fill=MUTED, anchor="ma")
    s = get_settings()
    foot = H - (300 if story else 150)
    d.rounded_rectangle((W // 2 - 300, foot - 20, W // 2 + 300, foot + 50), radius=35, fill=ACCENT)
    d.text((W // 2, foot + 15), "HIKOYA PRO'da o'qing", font=_font("DejaVuSans.ttf", 34), fill=BG, anchor="mm")
    d.text((W // 2, foot + 80), f"t.me/{s.bot_username}", font=_font("DejaVuSans.ttf", 28), fill=MUTED, anchor="ma")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=86, optimize=True, progressive=True)
    return buf.getvalue()


async def work_card_url(db: AsyncSession, work: Work, story: bool = False) -> str:
    author = await db.get(AuthorProfile, work.primary_author_id)
    genre = await db.get(Genre, work.primary_genre_id) if work.primary_genre_id else None
    meta = " · ".join(x for x in [genre.name_latn if genre else "", f"{work.chapters_published} bob" if work.chapters_published > 1 else "", f"~{minutes_for_words(work.words_published)} daqiqa"] if x)
    stamp = f"{work.id}:{work.title}:{work.cover_asset_id}:{author.pen_name if author else ''}:{meta}:{'s' if story else 'm'}:v1"
    key = "share/" + hashlib.sha256(stamp.encode()).hexdigest()[:32] + ".jpg"
    st = get_storage()
    try:
        await st.get(key, True)
    except Exception:  # noqa: BLE001 — not rendered yet
        jpg = render_work_card(await _cover_image(db, work), work.title, author.pen_name if author else "", meta, story)
        await st.put(key, jpg, "image/jpeg", True)
    return st.public_url(key)


# ------------------------------------------------------------------ share links


async def _target(db: AsyncSession, target_type: str, target_id: int) -> tuple[str, Work | None, str]:
    """Returns (deep-link param, work for the card, title). Only publicly visible things."""
    if target_type == "work":
        w = await db.get(Work, target_id)
        if w is None or w.visibility != "public" or w.editorial_state not in ("published", "delisted"):
            raise NotFound("Asar topilmadi")
        return f"w_{w.short_code}", w, w.title
    if target_type == "chapter":
        c = await db.get(Chapter, target_id)
        w = await db.get(Work, c.work_id) if c else None
        if c is None or w is None or c.published_revision_id is None or c.is_deleted or w.visibility != "public":
            raise NotFound("Bob topilmadi")
        return f"c_{c.id}", w, f"{w.title}: {c.title}"
    if target_type == "author":
        a = await db.get(AuthorProfile, target_id)
        if a is None:
            raise NotFound("Muallif topilmadi")
        return f"a_{a.id}", None, a.pen_name
    if target_type == "app":
        return "", None, "HIKOYA PRO"
    raise NotFound()


async def get_share(db: AsyncSession, user: User | None, target_type: str, target_id: int, channel: str) -> ShareLink:
    """One row per (user, target, channel): repeated taps reuse it, so counts stay honest."""
    channel = channel if channel in CHANNELS else "link"
    uid = user.id if user else None
    sl = await db.scalar(select(ShareLink).where(ShareLink.user_id == uid, ShareLink.target_type == target_type, ShareLink.target_id == target_id, ShareLink.channel == channel))
    if sl is None:
        sl = ShareLink(user_id=uid, target_type=target_type, target_id=target_id, channel=channel)
        db.add(sl)
        await db.flush()
    return sl


def _caption(title: str, author: str, synopsis: str) -> str:
    from html import escape

    syn = (synopsis or "").strip()
    if len(syn) > 220:
        syn = syn[:220].rsplit(" ", 1)[0] + "…"
    parts = [f"<b>{escape(title)}</b>"]
    if author:
        parts.append(f"✍️ {escape(author)}")
    if syn:
        parts.append(f"\n{escape(syn)}")
    return "\n".join(parts)


def _photo_result(rid: str, card: str, caption: str, link: str, title: str) -> dict:
    return {
        "type": "photo",
        "id": rid[:64],
        "photo_url": card,
        "thumbnail_url": card,
        "title": title[:64],
        "caption": caption[:1024],
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": [[{"text": "📖 O'qish", "url": link}]]},
    }


async def prepare(db: AsyncSession, user: User, target_type: str, target_id: int, channel: str) -> dict:
    param, work, title = await _target(db, target_type, target_id)
    sl = await get_share(db, user, target_type, target_id, channel)
    full_param = f"{param}__s{sl.id}" if param else f"r_{user.id}__s{sl.id}"
    link = app_link(full_param)
    author = await db.get(AuthorProfile, work.primary_author_id) if work else None
    text = f"«{title}» — HIKOYA PRO'da o'qing" if work else f"{title}: o'zbekcha hikoyalar Telegram ichida"
    out: dict = {"share_id": sl.id, "link": link, "text": text, "image_url": None, "prepared_message_id": None, "bot_username": get_settings().bot_username}
    if work is not None:
        out["image_url"] = await work_card_url(db, work, story=(channel == "story"))
    if channel == "message" and work is not None:
        result = _photo_result(f"s{sl.id}", out["image_url"], _caption(title, author.pen_name if author else "", work.synopsis), link, title)
        try:
            prepared = await get_telegram().call(
                "savePreparedInlineMessage", user_id=user.telegram_user_id, result=result,
                allow_user_chats=True, allow_group_chats=True, allow_channel_chats=True, allow_bot_chats=False,
            )
            if isinstance(prepared, dict):
                out["prepared_message_id"] = prepared.get("id")
        except (TelegramError, TelegramUncertain):
            pass  # the client falls back to a t.me/share link
    return out


async def record_open(db: AsyncSession, user: User, start_param: str) -> bool:
    """Count an open of a share link; bind brand-new users to the sharer as a referral."""
    _, share_id = split_param(start_param)
    if share_id is None:
        return False
    sl = await db.get(ShareLink, share_id)
    if sl is None or sl.user_id == user.id:
        return False
    is_new = user.created_at > utcnow() - timedelta(minutes=30)
    res = await db.execute(insert(ShareOpen).values(share_id=sl.id, user_id=user.id, is_new_user=is_new).on_conflict_do_nothing().returning(ShareOpen.user_id))
    if res.scalar() is None:
        return False
    await db.execute(update(ShareLink).where(ShareLink.id == sl.id).values(opens=ShareLink.opens + 1, new_users=ShareLink.new_users + (1 if is_new else 0)))
    if is_new and sl.user_id:
        from app.services.growth import bind_referral

        await bind_referral(db, user, f"r_{sl.user_id}")
    return True


async def my_stats(db: AsyncSession, user: User) -> dict:
    row = (await db.execute(select(func.count(), func.coalesce(func.sum(ShareLink.opens), 0), func.coalesce(func.sum(ShareLink.new_users), 0)).where(ShareLink.user_id == user.id))).one()
    return {"shares": int(row[0]), "opens": int(row[1]), "new_users": int(row[2]), "bot_username": get_settings().bot_username}


async def work_share_stats(db: AsyncSession, work_id: int) -> dict:
    rows = (await db.execute(select(ShareLink.channel, func.count(), func.coalesce(func.sum(ShareLink.opens), 0), func.coalesce(func.sum(ShareLink.new_users), 0)).where(ShareLink.target_type == "work", ShareLink.target_id == work_id).group_by(ShareLink.channel))).all()
    return {"by_channel": [{"channel": c, "shares": int(n), "opens": int(o), "new_users": int(nu)} for c, n, o, nu in rows]}


# ------------------------------------------------------------------ inline mode


async def inline_answer(db: AsyncSession, iq: dict) -> dict:
    """answerInlineQuery params for «@bot <words>»: public works as photo cards with a read button."""
    from app.services.access import Entitlements
    from app.services.access import catalog_visible_clause
    from app.services.catalog import search
    from app.services.identity import get_or_create_user_by_tg

    frm = iq.get("from") or {}
    user = await get_or_create_user_by_tg(db, int(frm.get("id", 0)), frm.get("first_name", "")) if frm.get("id") else None
    q = (iq.get("query") or "").strip()[:64]
    if q:
        res = await search(db, None, Entitlements(), q, {}, limit=10)
        ids = [it["id"] for it in res["items"]]
        works = [w for w in (await db.scalars(select(Work).where(Work.id.in_(ids)))).all()] if ids else []
        works.sort(key=lambda w: ids.index(w.id))
    else:
        works = list((await db.scalars(select(Work).where(catalog_visible_clause()).order_by(Work.likes_count.desc(), Work.published_at.desc()).limit(10))).all())
    results = []
    for w in works:
        if w.visibility != "public":
            continue
        sl = await get_share(db, user, "work", w.id, "inline")
        author = await db.get(AuthorProfile, w.primary_author_id)
        card = await work_card_url(db, w)
        results.append(_photo_result(f"w{w.id}", card, _caption(w.title, author.pen_name if author else "", w.synopsis), app_link(f"w_{w.short_code}__s{sl.id}"), w.title))
    s = get_settings()
    return {
        "inline_query_id": iq["id"],
        "results": results,
        "cache_time": 30,
        "is_personal": True,
        "button": {"text": "📚 Barcha hikoyalar", "web_app": {"url": s.webapp_url}},
    }

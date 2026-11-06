"""Reader companions: chapter recap, spoiler-safe character cards, beta readers (spec stage C).

Spoiler rule shared by all three: something tied to chapter N is shown to a reader only after
they have read chapter N (ChapterCompletion or furthest position past it). Staff with edit rights
see everything. Beta reading is never counted in reads, TOP or author stats.
"""

from __future__ import annotations

import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import content_schema as cs
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.text import clean_plain
from app.core.timeutil import utcnow
from app.models import (
    BetaReaderGrant,
    Chapter,
    ChapterCompletion,
    ChapterRevision,
    Character,
    EditorNote,
    ReadingProgress,
    User,
    Work,
)
from app.services.identity import Actor, audit, can_edit_work, require_edit_work


async def read_chapter_ids(db: AsyncSession, user_id: int | None, work_id: int) -> set[int]:
    """Chapters of the work this user has finished (completion record or furthest position past it)."""
    if not user_id:
        return set()
    done = set((await db.scalars(select(ChapterCompletion.chapter_id).join(Chapter, Chapter.id == ChapterCompletion.chapter_id).where(ChapterCompletion.user_id == user_id, Chapter.work_id == work_id))).all())
    prog = await db.get(ReadingProgress, (user_id, work_id))
    if prog and prog.furthest_sort_key:
        done |= set((await db.scalars(select(Chapter.id).where(Chapter.work_id == work_id, Chapter.sort_key < prog.furthest_sort_key))).all())
    return done


# ---------------------------------------------------------------- recap


async def recap_before(db: AsyncSession, user: User | None, chapter: Chapter) -> dict | None:
    """«Qayerda to'xtagandim?»: the recap of the previous published chapter, only if it was read."""
    if user is None:
        return None
    prev = await db.scalar(
        select(Chapter)
        .where(Chapter.work_id == chapter.work_id, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None), Chapter.sort_key < chapter.sort_key)
        .order_by(Chapter.sort_key.desc())
        .limit(1)
    )
    if prev is None or not prev.recap.strip():
        return None
    if prev.id not in await read_chapter_ids(db, user.id, chapter.work_id):
        return None
    return {"chapter_id": prev.id, "chapter_title": prev.title, "text": prev.recap}


# ---------------------------------------------------------------- characters


def _character_dto(c: Character, avatar: str | None = None, chapter_title: str = "") -> dict:
    return {"id": c.id, "name": c.name, "description": c.description, "avatar_url": avatar, "reveal_chapter_id": c.reveal_chapter_id, "reveal_chapter_title": chapter_title, "sort_order": c.sort_order}


async def list_characters(db: AsyncSession, work: Work, user_id: int | None, staff: bool = False) -> dict:
    from app.services.catalog import asset_urls

    rows = (await db.scalars(select(Character).where(Character.work_id == work.id).order_by(Character.sort_order, Character.id))).all()
    read = await read_chapter_ids(db, user_id, work.id) if not staff else set()
    visible = [c for c in rows if staff or c.reveal_chapter_id is None or c.reveal_chapter_id in read]
    avatars = await asset_urls(db, {c.avatar_asset_id for c in visible if c.avatar_asset_id}, width=240)
    titles = {}
    if staff:
        ids = {c.reveal_chapter_id for c in visible if c.reveal_chapter_id}
        if ids:
            titles = {cid: t for cid, t in (await db.execute(select(Chapter.id, Chapter.title).where(Chapter.id.in_(ids)))).all()}
    return {
        "items": [_character_dto(c, avatars.get(c.avatar_asset_id) if c.avatar_asset_id else None, titles.get(c.reveal_chapter_id, "")) for c in visible],
        # how many are still hidden, without names (no spoilers)
        "hidden_count": len(rows) - len(visible),
    }


async def _check_reveal_chapter(db: AsyncSession, work: Work, chapter_id: int | None) -> None:
    if chapter_id is None:
        return
    ch = await db.get(Chapter, chapter_id)
    if ch is None or ch.work_id != work.id or ch.is_deleted:
        raise Invalid("Bob shu asarga tegishli emas", code="chapter_mismatch")


async def save_character(db: AsyncSession, actor: Actor, work: Work, data: dict, character: Character | None = None) -> Character:
    await require_edit_work(db, actor, work)
    name = clean_plain(str(data.get("name", character.name if character else "")), 120)
    if not name:
        raise Invalid("Ism kerak", code="name_required")
    reveal = data.get("reveal_chapter_id", character.reveal_chapter_id if character else None)
    await _check_reveal_chapter(db, work, reveal)
    if character is None:
        character = Character(work_id=work.id, name=name)
        db.add(character)
    character.name = name
    if "description" in data:
        character.description = clean_plain(str(data["description"]), 2000)
    character.reveal_chapter_id = reveal
    if "avatar_asset_id" in data:
        character.avatar_asset_id = data["avatar_asset_id"]
        if data["avatar_asset_id"]:
            from app.models import Asset
            from app.services.assets import make_public

            a = await db.get(Asset, int(data["avatar_asset_id"]))
            if a is None or a.kind != "image" or (a.owner_id != actor.id and not actor.has("work.edit_any")):
                raise Invalid("Rasm topilmadi", code="asset_invalid")
            await make_public(db, a)
    if "sort_order" in data:
        character.sort_order = int(data["sort_order"])
    await db.flush()
    await audit(db, actor, "character.save", "work", work.id, after={"character_id": character.id})
    return character


async def delete_character(db: AsyncSession, actor: Actor, character: Character) -> None:
    work = await db.get(Work, character.work_id)
    assert work is not None
    await require_edit_work(db, actor, work)
    await db.delete(character)
    await audit(db, actor, "character.delete", "work", work.id, before={"character_id": character.id})


# ---------------------------------------------------------------- beta readers


def _grant_active(g: BetaReaderGrant) -> bool:
    return g.revoked_at is None and g.expires_at > utcnow()


async def create_beta_invite(db: AsyncSession, actor: Actor, work: Work, chapter_id: int | None, days: int = 14, note: str = "") -> BetaReaderGrant:
    await require_edit_work(db, actor, work)
    if not 1 <= days <= 90:
        raise Invalid("Muddat 1–90 kun", code="days_invalid")
    if chapter_id is not None:
        ch = await db.get(Chapter, chapter_id)
        if ch is None or ch.work_id != work.id or ch.is_deleted:
            raise Invalid("Bob topilmadi", code="chapter_mismatch")
    g = BetaReaderGrant(work_id=work.id, chapter_id=chapter_id, token=secrets.token_urlsafe(12), note=clean_plain(note, 500), created_by=actor.id, expires_at=utcnow() + timedelta(days=days))
    db.add(g)
    await db.flush()
    await audit(db, actor, "beta.invite", "work", work.id, after={"grant_id": g.id, "chapter_id": chapter_id, "days": days})
    return g


async def redeem_beta(db: AsyncSession, user: User, token: str) -> BetaReaderGrant:
    """A link is single-person: the first user who opens it owns it; others get 404."""
    g = await db.scalar(select(BetaReaderGrant).where(BetaReaderGrant.token == token).with_for_update())
    if g is None or not _grant_active(g) or (g.user_id is not None and g.user_id != user.id):
        raise NotFound("Taklif topilmadi yoki muddati tugagan")
    if g.user_id is None:
        g.user_id, g.redeemed_at = user.id, utcnow()
    return g


async def _beta_grant_for(db: AsyncSession, user_id: int, chapter: Chapter) -> BetaReaderGrant | None:
    rows = (await db.scalars(select(BetaReaderGrant).where(BetaReaderGrant.user_id == user_id, BetaReaderGrant.work_id == chapter.work_id))).all()
    for g in rows:
        if _grant_active(g) and (g.chapter_id is None or g.chapter_id == chapter.id):
            return g
    return None


async def beta_overview(db: AsyncSession, user: User, token: str) -> dict:
    g = await redeem_beta(db, user, token)
    work = await db.get(Work, g.work_id)
    assert work is not None
    q = select(Chapter).where(Chapter.work_id == work.id, Chapter.is_deleted.is_(False)).order_by(Chapter.sort_key)
    if g.chapter_id:
        q = q.where(Chapter.id == g.chapter_id)
    chapters = [c for c in (await db.scalars(q)).all() if c.draft_revision_id or c.published_revision_id]
    return {
        "work": {"id": work.id, "title": work.title, "synopsis": work.synopsis},
        "note": g.note,
        "expires_at": g.expires_at.isoformat(),
        "chapters": [{"id": c.id, "title": c.title, "state": c.editorial_state, "words": c.words} for c in chapters],
    }


async def beta_chapter(db: AsyncSession, actor: Actor, chapter_id: int) -> dict:
    ch = await db.get(Chapter, chapter_id)
    if ch is None or ch.is_deleted:
        raise NotFound("Bob topilmadi")
    work = await db.get(Work, ch.work_id)
    assert work is not None
    staff = await can_edit_work(db, actor, work)
    if not staff and await _beta_grant_for(db, actor.id, ch) is None:
        raise NotFound("Bob topilmadi")
    head = ch.draft_revision_id or ch.published_revision_id
    rev = await db.get(ChapterRevision, head) if head else None
    if rev is None:
        raise NotFound("Bobda matn yo'q")
    from app.services.catalog import asset_urls

    images = await asset_urls(db, set(cs.asset_ids(rev.content_json)), width=640)
    mine = (await db.scalars(select(EditorNote).where(EditorNote.chapter_id == ch.id, EditorNote.author_user_id == actor.id).order_by(EditorNote.id))).all()
    # no reading session, no progress, no qualified read: beta reads stay out of stats
    return {
        "work": {"id": work.id, "title": work.title},
        "chapter": {"id": ch.id, "title": ch.title},
        "revision_id": rev.id,
        "content": rev.content_json,
        "images": {str(k): v for k, v in images.items()},
        "my_feedback": [{"id": n.id, "block_id": n.block_id, "body": n.body, "created_at": n.created_at.isoformat()} for n in mine],
        "beta": True,
    }


async def beta_feedback(db: AsyncSession, actor: Actor, chapter_id: int, body: str, block_id: str = "") -> EditorNote:
    ch = await db.get(Chapter, chapter_id)
    if ch is None or ch.is_deleted:
        raise NotFound("Bob topilmadi")
    if await _beta_grant_for(db, actor.id, ch) is None:
        raise Forbidden("Beta taklif faol emas", code="beta_inactive")
    text = clean_plain(body, 2000)
    if not text:
        raise Invalid("Fikr matni bo'sh", code="body_required")
    head = ch.draft_revision_id or ch.published_revision_id
    note = EditorNote(chapter_id=ch.id, revision_id=head, block_id=block_id[:32], author_user_id=actor.id, body=f"[Beta] {text}")
    db.add(note)
    await db.flush()
    return note


async def list_beta_invites(db: AsyncSession, actor: Actor, work: Work) -> list[dict]:
    await require_edit_work(db, actor, work)
    rows = (await db.scalars(select(BetaReaderGrant).where(BetaReaderGrant.work_id == work.id).order_by(BetaReaderGrant.id.desc()))).all()
    users = {u.id: u for u in (await db.scalars(select(User).where(User.id.in_({g.user_id for g in rows if g.user_id})))).all()} if rows else {}
    from app.config import get_settings

    s = get_settings()
    return [
        {
            "id": g.id,
            "chapter_id": g.chapter_id,
            "link": f"https://t.me/{s.bot_username}/{s.miniapp_short_name}?startapp=b_{g.token}",
            "reader": users[g.user_id].display_name if g.user_id in users else None,
            "active": _grant_active(g),
            "expires_at": g.expires_at.isoformat(),
            "note": g.note,
        }
        for g in rows
    ]


async def revoke_beta(db: AsyncSession, actor: Actor, grant_id: int) -> None:
    g = await db.get(BetaReaderGrant, grant_id)
    if g is None:
        raise NotFound()
    work = await db.get(Work, g.work_id)
    assert work is not None
    await require_edit_work(db, actor, work)
    g.revoked_at = utcnow()
    await audit(db, actor, "beta.revoke", "work", work.id, after={"grant_id": g.id})

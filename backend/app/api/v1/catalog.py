from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query
from sqlalchemy import delete, func, select

from app.api.deps import DB, Ents, OptActor, limiter
from app.core import content_schema as cs
from app.core.errors import AccessRequired, NotFound
from app.core.text import minutes_for_words, render_script
from app.core.timeutil import utcnow
from app.models import (
    AssetLink,
    AuthorProfile,
    Chapter,
    ChapterCompletion,
    ChapterRevision,
    Follow,
    Genre,
    HomeSection,
    LibraryItem,
    Like,
    RecentSearch,
    Tag,
    Thanks,
    Work,
    WorkContributor,
    WorkGenre,
    WorkTag,
)
from app.services import catalog as cat
from app.services.access import can_see_work_page, chapter_policy, decide_chapter_access
from app.services.catalog import CardBuilder, asset_urls
from app.services.content import get_work_by_code
from app.services.reading import get_progress, progress_dto, resolve_position, start_session

router = APIRouter(tags=["catalog"])


@router.get("/home")
async def get_home(db: DB, actor: OptActor, ent: Ents, eager: int = 5):
    data = await cat.home(db, actor.user if actor else None, ent, eager=max(1, min(eager, 12)))
    data["has_stories"] = await cat.has_active_stories(db)
    return data


@router.get("/home/sections/{key}")
async def get_home_section(key: str, db: DB, actor: OptActor, ent: Ents, exclude: str = ""):
    sec = await db.scalar(select(HomeSection).where(HomeSection.key == key, HomeSection.active.is_(True)))
    if sec is None:
        raise NotFound()
    ex = {int(x) for x in exclude.split(",") if x.isdigit()}
    return await cat.section_items(db, actor.user if actor else None, ent, sec, ex)


@router.get("/genres")
async def get_genres(db: DB, actor: OptActor):
    return await cat.genres_list(db, actor.user.script if actor else "latn")


@router.get("/tags")
async def get_tags(db: DB, kind: str | None = None):
    q = select(Tag).where(Tag.active.is_(True))
    if kind:
        q = q.where(Tag.kind == kind)
    return [{"id": t.id, "slug": t.slug, "name": t.name_latn, "name_cyrl": t.name_cyrl, "kind": t.kind} for t in (await db.scalars(q.order_by(Tag.id))).all()]


@router.get("/works")
async def get_works(
    db: DB,
    actor: OptActor,
    ent: Ents,
    genre: list[str] | None = Query(None),
    access: str | None = None,
    status: str | None = None,
    format: str | None = None,
    script: str | None = None,
    has_audio: bool | None = None,
    min_minutes: int | None = None,
    max_minutes: int | None = None,
    tag: str | None = None,
    author_id: int | None = None,
    new_authors: bool | None = None,
    sort: str = "new",
    period: str = "month",
    cursor: str | None = None,
    limit: int = 20,
):
    f = {k: v for k, v in dict(genre=genre, access=access, status=status, format=format, script=script, has_audio=has_audio, min_minutes=min_minutes,
                                max_minutes=max_minutes, tag=tag, author_id=author_id, new_authors=new_authors, sort=sort, period=period).items() if v is not None}
    return await cat.list_works(db, actor.user if actor else None, ent, f, limit, cursor)


@router.get("/search")
async def get_search(
    db: DB,
    actor: OptActor,
    ent: Ents,
    q: str = Query("", max_length=120),
    genre: list[str] | None = Query(None),
    access: str | None = None,
    status: str | None = None,
    in_text: bool = False,
    cursor: str | None = None,
    limit: int = 20,
):
    if actor:
        limiter.hit(f"search:{actor.id}", 60, 60)
    f = {k: v for k, v in dict(genre=genre, access=access, status=status).items() if v is not None}
    res = await cat.search(db, actor.user if actor else None, ent, q, f, limit, cursor, in_text)
    if actor and q.strip() and not cursor:
        from sqlalchemy.dialects.postgresql import insert

        await db.execute(
            insert(RecentSearch).values(user_id=actor.id, query=q.strip()[:120]).on_conflict_do_update(index_elements=["user_id", "query"], set_={"created_at": utcnow()})
        )
    return res


@router.get("/search/recent")
async def recent_searches(db: DB, actor: OptActor):
    if not actor:
        return []
    rows = (await db.scalars(select(RecentSearch).where(RecentSearch.user_id == actor.id).order_by(RecentSearch.created_at.desc()).limit(10))).all()
    return [{"id": r.id, "query": r.query} for r in rows]


@router.delete("/search/recent")
async def clear_recent(db: DB, actor: OptActor, id: int | None = None):
    if actor:
        q = delete(RecentSearch).where(RecentSearch.user_id == actor.id)
        if id:
            q = q.where(RecentSearch.id == id)
        await db.execute(q)
    return {"ok": True}


@router.get("/rankings")
async def get_rankings(db: DB, actor: OptActor, ent: Ents, metric: str = "most_read", period: str = "week", genre: str | None = None, limit: int = 10):
    if period not in ("today", "week", "month", "all"):
        period = "week"
    if metric not in ("most_read", "trend", "thanks"):
        metric = "most_read"
    return await cat.rankings(db, actor.user if actor else None, ent, metric, period, genre, max(1, min(limit, 50)))


async def _load_visible_work(db, code_or_id: str, actor, ent) -> Work:
    work = await get_work_by_code(db, code_or_id)
    if work is None and code_or_id.isdigit():
        work = await db.get(Work, int(code_or_id))
    if work is None or not await can_see_work_page(db, work, actor.id if actor else None, ent):
        raise NotFound("Asar topilmadi")
    return work


@router.get("/works/{code}")
async def get_work(code: str, db: DB, actor: OptActor, ent: Ents):
    work = await _load_visible_work(db, code, actor, ent)
    user = actor.user if actor else None
    script = user.script if user else "latn"
    card = (await CardBuilder(db, user, ent).build([work]))[0]
    contributors = (
        await db.execute(
            select(WorkContributor.contribution_type, AuthorProfile).join(AuthorProfile, AuthorProfile.id == WorkContributor.author_id).where(WorkContributor.work_id == work.id).order_by(WorkContributor.display_order)
        )
    ).all()
    avatars = await asset_urls(db, {a.avatar_asset_id for _, a in contributors if a.avatar_asset_id})
    genres = (await db.execute(select(Genre, WorkGenre.is_primary).join(WorkGenre, WorkGenre.genre_id == Genre.id).where(WorkGenre.work_id == work.id))).all()
    tags = (await db.scalars(select(Tag).join(WorkTag, WorkTag.tag_id == Tag.id).where(WorkTag.work_id == work.id))).all()
    toc = await _toc(db, work, user, ent)
    files = await _public_files(db, work, ent)
    state = {}
    if user:
        prog = await get_progress(db, user.id, work.id)
        th = await db.get(Thanks, (user.id, work.id))
        state = {
            "liked": await db.get(Like, (user.id, work.id)) is not None,
            "thanked": bool(th and th.active),
            "thanks_reason": th.reason if th and th.active else None,
            "in_library": await db.get(LibraryItem, (user.id, work.id)) is not None,
            "following_work": await db.get(Follow, (user.id, "work", work.id)) is not None,
            "following_author": await db.get(Follow, (user.id, "author", work.primary_author_id)) is not None,
            "notify_on_complete": bool((f := await db.get(Follow, (user.id, "work", work.id))) and f.notify_on_complete),
            "progress": progress_dto(prog) if prog else None,
        }
    published = [c for c in toc if c["published"]]
    history = sorted(({"chapter_id": c["id"], "title": c["title"], "published_at": c["published_at"]} for c in published if c["published_at"]), key=lambda x: x["published_at"], reverse=True)[:10]
    start_label = "start"
    if state.get("progress"):
        start_label = "reread" if state["progress"]["completion_state"] == "completed" else "continue"
    return {
        **card,
        "title": render_script(work.title, work.script, script),
        "original_title": work.title,
        "synopsis": render_script(work.synopsis, work.script, script),
        "script": work.script,
        "contributors": [
            {"type": t, "id": a.id, "pen_name": a.pen_name, "verified": a.verification_status == "verified", "avatar_url": avatars.get(a.avatar_asset_id or 0)} for t, a in contributors
        ],
        "genres": [{"slug": g.slug, "name": g.name_cyrl if script == "cyrl" else g.name_latn, "primary": p} for g, p in genres],
        "tags": [{"slug": t.slug, "name": t.name_cyrl if script == "cyrl" else t.name_latn, "kind": t.kind} for t in tags],
        "access_policy": work.access_policy,
        "editorial_state": work.editorial_state,
        "suspended_reason": work.suspended_reason if work.editorial_state == "suspended" else "",
        "delisted": work.editorial_state == "delisted",
        "content_flags": {k: v for k, v in (work.content_flags or {}).items() if k in ("age_rating", "author_claim", "illustrated")},
        "planned_chapters": work.planned_chapters,
        "next_release_at": work.next_release_at.isoformat() if work.next_release_at else None,
        "next_release_note": work.next_release_note,
        "minutes_is_estimate": True,
        "counters": {"likes": work.likes_count, "thanks": work.thanks_count, "comments": work.comments_count},
        "comments_policy": work.comments_policy,
        "toc": toc,
        "files": files,
        "update_history": history,
        "user_state": state,
        "start_action": start_label,
        "share_url": f"https://t.me/{_bot()}/{_app()}?startapp=w_{work.short_code}",
    }


def _bot() -> str:
    from app.config import get_settings

    return get_settings().bot_username


def _app() -> str:
    from app.config import get_settings

    return get_settings().miniapp_short_name


async def _toc(db, work: Work, user, ent) -> list[dict]:
    now = utcnow()
    chapters = (
        await db.scalars(select(Chapter).where(Chapter.work_id == work.id, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None)).order_by(Chapter.sort_key))
    ).all()
    done = set()
    if user:
        done = set((await db.scalars(select(ChapterCompletion.chapter_id).where(ChapterCompletion.user_id == user.id, ChapterCompletion.work_id == work.id))).all())
    out = []
    for i, c in enumerate(chapters):
        released = c.published_at is not None and c.published_at <= now
        if not released:
            continue
        acc = decide_chapter_access(work, c, ent, now)
        out.append(
            {
                "id": c.id,
                "index": i + 1,
                "title": render_script(c.title, work.script, user.script if user else "latn"),
                "minutes": minutes_for_words(c.words),
                "published": True,
                "published_at": c.published_at.isoformat() if c.published_at else None,
                "access": "open" if acc.full else ("locked" if acc.reason == "locked" else acc.reason),
                "policy": chapter_policy(work, c, now),
                "free_sample": c.access_override == "free_sample",
                "completed": c.id in done,
                "is_new": bool(c.published_at and (now - c.published_at).days < 7),
                "has_audio": c.has_audio,
            }
        )
    return out


async def _public_files(db, work: Work, ent) -> list[dict]:
    from app.models import Asset

    rows = (
        await db.execute(
            select(AssetLink, Asset).join(Asset, Asset.id == AssetLink.asset_id).where(
                AssetLink.target_type == "work", AssetLink.target_id == work.id, AssetLink.purpose.in_(("attachment", "audio")), Asset.processing_state == "ready"
            ).order_by(AssetLink.sort_order)
        )
    ).all()
    out = []
    for link, asset in rows:
        out.append(
            {
                "link_id": link.id,
                "asset_id": asset.id,
                "purpose": link.purpose,
                "title": link.title or asset.original_name,
                "mime": asset.mime,
                "size_bytes": asset.size_bytes,
                "duration": (asset.meta or {}).get("duration"),
                "download_allowed": link.download_allowed,
                # the URL is obtained via /assets/{id}/access which checks entitlement each time
            }
        )
    return out


@router.get("/works/{code}/chapters")
async def get_toc(code: str, db: DB, actor: OptActor, ent: Ents):
    work = await _load_visible_work(db, code, actor, ent)
    return await _toc(db, work, actor.user if actor else None, ent)


async def _chapter_payload(db, actor, ent, chapter_id: int, *, device_id: str = "", preview_only: bool = False) -> dict:
    chapter = await db.get(Chapter, chapter_id)
    if chapter is None or chapter.is_deleted:
        raise NotFound("Bob topilmadi")
    work = await db.get(Work, chapter.work_id)
    if work is None or not await can_see_work_page(db, work, actor.id if actor else None, ent):
        raise NotFound("Bob topilmadi")
    acc = decide_chapter_access(work, chapter, ent)
    if acc.mode == "unavailable":
        if acc.reason == "suspended":
            raise AccessRequired(work.suspended_reason or "Asar vaqtincha to'xtatilgan", code="work_suspended", reason="suspended")
        raise NotFound("Bob hali chiqmagan")
    rev = await db.get(ChapterRevision, chapter.published_revision_id)
    assert rev is not None
    full = acc.full and not preview_only
    doc = rev.content_json if full else cs.preview_doc(rev.content_json, chapter.preview_blocks)
    user = actor.user if actor else None
    neighbours = (
        await db.scalars(
            select(Chapter).where(Chapter.work_id == work.id, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None), Chapter.published_at <= utcnow()).order_by(Chapter.sort_key)
        )
    ).all()
    ids = [c.id for c in neighbours]
    idx = ids.index(chapter.id) if chapter.id in ids else -1
    prev_id = ids[idx - 1] if idx > 0 else None
    next_ch = neighbours[idx + 1] if 0 <= idx < len(ids) - 1 else None
    position = None
    session_id = None
    if user:
        prog = await get_progress(db, user.id, work.id)
        if prog and prog.chapter_id == chapter.id:
            position = await resolve_position(db, prog.chapter_revision_id, prog.current_block_id, rev)
            position["ratio"] = prog.current_ratio
            position["offset"] = prog.current_offset
        if full:
            sess = await start_session(db, user, work, chapter, rev.id, device_id, False, len(rev.block_ids or []))
            session_id = sess.public_id
    images = await asset_urls(db, set(cs.asset_ids(doc)))
    audio = None
    if full and chapter.has_audio:
        link = await db.scalar(select(AssetLink).where(AssetLink.target_type == "chapter", AssetLink.target_id == chapter.id, AssetLink.purpose == "audio"))
        if link:
            audio = {"asset_id": link.asset_id}
    return {
        "work": {"id": work.id, "code": work.short_code, "title": work.title, "script": work.script, "access_policy": work.access_policy, "comments_policy": work.comments_policy},
        "chapter": {"id": chapter.id, "title": chapter.title, "index": idx + 1, "total": len(ids), "minutes": minutes_for_words(chapter.words), "words": chapter.words},
        "revision_id": rev.id,
        "mode": "full" if full else "preview",
        "access": {"reason": acc.reason, "offers": acc.offers},
        "content": doc,
        "total_blocks": len(rev.block_ids or []) if full else None,
        "images": {str(k): v for k, v in images.items()},
        "audio": audio,
        "prev_chapter_id": prev_id,
        # access of the next chapter is checked again when it is opened; here only a hint
        "next_chapter": ({"id": next_ch.id, "title": next_ch.title, "locked": not decide_chapter_access(work, next_ch, ent).full} if next_ch else None),
        "position": position,
        "session_id": session_id,
    }


@router.get("/chapters/{chapter_id}/content")
async def chapter_content(chapter_id: int, db: DB, actor: OptActor, ent: Ents, device_id: str = ""):
    """Full text only for entitled users; otherwise the free preview blocks + offers (never the full body)."""
    return await _chapter_payload(db, actor, ent, chapter_id, device_id=device_id[:64])


@router.get("/chapters/{chapter_id}/preview")
async def chapter_preview(chapter_id: int, db: DB, actor: OptActor, ent: Ents):
    return await _chapter_payload(db, actor, ent, chapter_id, preview_only=True)


@router.get("/authors/{author_id}")
async def get_author(author_id: int, db: DB, actor: OptActor, ent: Ents):
    from app.models import AuthorStory, StoryHighlight

    a = await db.get(AuthorProfile, author_id)
    if a is None:
        raise NotFound("Muallif topilmadi")
    user = actor.user if actor else None
    works = (
        await db.scalars(
            select(Work).where(Work.primary_author_id == a.id, Work.editorial_state == "published", Work.visibility == "public").order_by(Work.published_at.desc()).limit(50)
        )
    ).all()
    cards = await CardBuilder(db, user, ent).build(list(works))
    genres = (
        await db.execute(
            select(Genre.slug, Genre.name_latn).join(WorkGenre, WorkGenre.genre_id == Genre.id).join(Work, Work.id == WorkGenre.work_id).where(Work.primary_author_id == a.id).group_by(Genre.slug, Genre.name_latn)
        )
    ).all()
    followers = await db.scalar(select(func.count()).select_from(Follow).where(Follow.target_type == "author", Follow.target_id == a.id))
    totals = (await db.execute(select(func.coalesce(func.sum(Work.likes_count), 0), func.coalesce(func.sum(Work.thanks_count), 0)).where(Work.primary_author_id == a.id, Work.editorial_state == "published"))).one()
    highlights = (await db.scalars(select(StoryHighlight).where(StoryHighlight.author_id == a.id).order_by(StoryHighlight.sort_key))).all()
    has_story = bool(await db.scalar(select(AuthorStory.id).where(AuthorStory.author_id == a.id, AuthorStory.status == "published", AuthorStory.expires_at > utcnow()).limit(1)))
    avatar = (await asset_urls(db, {a.avatar_asset_id} if a.avatar_asset_id else set())).get(a.avatar_asset_id or 0)
    return {
        "id": a.id,
        "pen_name": a.pen_name,
        "slug": a.slug,
        "bio": a.bio,
        "avatar_url": avatar,
        "verified": a.verification_status == "verified",
        "genres": [{"slug": g[0], "name": g[1]} for g in genres],
        "works": cards,
        "series": [c for c in cards if c["format"] in ("series", "novel") and c["completion_state"] == "ongoing"],
        "followers": followers or 0,
        "likes": int(totals[0]),
        "thanks": int(totals[1]),
        "next_release_note": a.next_release_note,
        "highlights": [{"id": h.id, "title": h.title} for h in highlights],
        "has_active_story": has_story,
        "is_demo": a.is_demo,
        "following": bool(user and await db.get(Follow, (user.id, "author", a.id))),
        "is_me": bool(actor and a.id in actor.author_ids),
    }


@router.get("/authors")
async def list_authors(db: DB, q: str = "", cursor: str | None = None, limit: int = 30):
    from app.core.text import normalize_for_search

    offset = cat.decode_cursor(cursor)
    has_work = select(Work.primary_author_id).where(Work.editorial_state == "published", Work.visibility == "public")
    query = select(AuthorProfile).where(AuthorProfile.id.in_(has_work))
    if q.strip():
        query = query.where(AuthorProfile.search_text.ilike(f"%{normalize_for_search(q)}%"))
    rows = (await db.scalars(query.order_by(AuthorProfile.editorial_featured.desc(), AuthorProfile.pen_name).offset(offset).limit(limit + 1))).all()
    avatars = await asset_urls(db, {a.avatar_asset_id for a in rows if a.avatar_asset_id})
    items = [{"id": a.id, "pen_name": a.pen_name, "avatar_url": avatars.get(a.avatar_asset_id or 0), "verified": a.verification_status == "verified", "featured": a.editorial_featured} for a in rows[:limit]]
    return {"items": items, "next_cursor": cat.encode_cursor(offset + limit) if len(rows) > limit else None}


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None

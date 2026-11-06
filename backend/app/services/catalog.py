"""Catalogue: cards, filters, search, rankings and the admin-managed home page (spec 6, 7, 13)."""

from __future__ import annotations

import base64
import json
import time
from datetime import timedelta

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.text import minutes_for_words, normalize_for_search, render_script
from app.core.timeutil import period_start_date, utcnow
from app.integrations.storage import get_storage
from app.models import (
    Asset,
    AuthorProfile,
    AuthorStory,
    Chapter,
    ChapterCompletion,
    ChapterRevision,
    CuratedCollection,
    CuratedItem,
    Dismissal,
    Follow,
    Genre,
    HomeSection,
    QualifiedRead,
    ReadingProgress,
    Tag,
    User,
    Work,
    WorkGenre,
    WorkTag,
)
from app.services.access import (
    PREMIUM_POLICIES,
    PURCHASE_POLICIES,
    Entitlements,
    access_badge,
    catalog_visible_clause,
    chapter_policy,
)

TREND_FORMULA = "trend-v1"
MOST_READ_FORMULA = "most-read-v1"
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl: float, value=None):
    if value is not None:
        _cache[key] = (time.monotonic() + ttl, value)
        return value
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def invalidate_cache() -> None:
    _cache.clear()


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        return max(0, int(json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))["o"]))
    except Exception:
        return 0


async def asset_urls(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    st = get_storage()
    rows = (await db.execute(select(Asset.id, Asset.storage_key, Asset.visibility, Asset.processing_state).where(Asset.id.in_(ids)))).all()
    return {r[0]: st.public_url(r[1]) for r in rows if r[2] == "public" and r[3] == "ready"}


class CardBuilder:
    """Builds compact cards for many works with few queries."""

    def __init__(self, db: AsyncSession, user: User | None, ent: Entitlements):
        self.db, self.user, self.ent = db, user, ent
        self.script = user.script if user else "latn"

    async def build(self, works: list[Work], *, with_progress: bool = True) -> list[dict]:
        if not works:
            return []
        author_ids = {w.primary_author_id for w in works}
        authors = {a.id: a for a in (await self.db.scalars(select(AuthorProfile).where(AuthorProfile.id.in_(author_ids)))).all()}
        covers = await asset_urls(self.db, {w.cover_asset_id for w in works if w.cover_asset_id})
        genres = {g.id: g for g in (await self.db.scalars(select(Genre).where(Genre.id.in_({w.primary_genre_id for w in works if w.primary_genre_id})))).all()}
        progress: dict[int, ReadingProgress] = {}
        if self.user and with_progress:
            progress = {
                p.work_id: p
                for p in (
                    await self.db.scalars(select(ReadingProgress).where(ReadingProgress.user_id == self.user.id, ReadingProgress.work_id.in_([w.id for w in works])))
                ).all()
            }
        out = []
        for w in works:
            a = authors.get(w.primary_author_id)
            g = genres.get(w.primary_genre_id or 0)
            p = progress.get(w.id)
            out.append(
                {
                    "id": w.id,
                    "code": w.short_code,
                    "title": render_script(w.title, w.script, self.script),
                    "cover_url": covers.get(w.cover_asset_id or 0),
                    "author": {"id": a.id, "pen_name": a.pen_name, "verified": a.verification_status == "verified"} if a else None,
                    "genre": ({"slug": g.slug, "name": g.name_cyrl if self.script == "cyrl" else g.name_latn} if g else None),
                    "access": access_badge(w, self.ent),
                    "format": w.format,
                    "completion_state": w.completion_state,
                    "chapters": w.chapters_published,
                    "minutes": minutes_for_words(w.words_published),
                    "has_audio": w.has_audio,
                    "is_demo": w.is_demo,
                    "progress": ({"ratio": p.current_ratio, "chapter_id": p.chapter_id, "completed": p.completion_state == "completed"} if p else None),
                    "last_chapter_at": w.last_chapter_published_at.isoformat() if w.last_chapter_published_at else None,
                }
            )
        return out


def _apply_filters(q, f: dict, user: User | None):
    genre = f.get("genre")
    if genre:
        slugs = genre if isinstance(genre, list) else [genre]
        q = q.where(Work.id.in_(select(WorkGenre.work_id).join(Genre, Genre.id == WorkGenre.genre_id).where(Genre.slug.in_(slugs))))
    access = f.get("access")
    if access == "free":
        q = q.where(Work.access_policy == "FREE")
    elif access == "premium":
        q = q.where(Work.access_policy.in_(PREMIUM_POLICIES))
    elif access == "purchase":
        q = q.where(Work.access_policy.in_(PURCHASE_POLICIES))
    elif access == "paid":
        q = q.where(Work.access_policy != "FREE")
    status = f.get("status") or ("completed" if (user and user.only_completed and f.get("respect_pref", True)) else None)
    if status in ("ongoing", "completed", "paused"):
        q = q.where(Work.completion_state == status)
    if f.get("format"):
        q = q.where(Work.format == f["format"])
    if f.get("script") in ("latn", "cyrl"):
        q = q.where(Work.script == f["script"])
    if f.get("has_audio"):
        q = q.where(Work.has_audio.is_(True))
    if f.get("min_minutes") is not None:
        q = q.where(Work.words_published >= int(f["min_minutes"]) * 180)
    if f.get("max_minutes") is not None:
        q = q.where(Work.words_published <= int(f["max_minutes"]) * 180)
    if f.get("tag"):
        q = q.where(Work.id.in_(select(WorkTag.work_id).join(Tag, Tag.id == WorkTag.tag_id).where(Tag.slug == f["tag"])))
    if f.get("author_id"):
        q = q.where(Work.primary_author_id == int(f["author_id"]))
    if f.get("new_authors"):
        since = utcnow() - timedelta(days=60)
        q = q.where(Work.primary_author_id.in_(select(AuthorProfile.id).where(AuthorProfile.created_at >= since)))
    if f.get("exclude_ids"):
        q = q.where(Work.id.not_in(f["exclude_ids"]))
    return q


def _apply_sort(q, sort: str):
    if sort == "thanks":
        return q.order_by(Work.thanks_count.desc(), Work.id.desc())
    if sort == "likes":
        return q.order_by(Work.likes_count.desc(), Work.id.desc())
    if sort == "updated":
        return q.order_by(Work.last_chapter_published_at.desc().nulls_last(), Work.id.desc())
    if sort == "short":
        return q.order_by(Work.words_published.asc(), Work.id.desc())
    return q.order_by(Work.published_at.desc().nulls_last(), Work.id.desc())


async def list_works(db: AsyncSession, user: User | None, ent: Entitlements, f: dict, limit: int = 20, cursor: str | None = None) -> dict:
    limit = max(1, min(limit, 50))
    offset = decode_cursor(cursor)
    q = select(Work).where(catalog_visible_clause())
    q = _apply_filters(q, f, user)
    if f.get("sort") == "popular":
        ps = period_start_date(f.get("period", "month"))
        reads = select(QualifiedRead.work_id, func.count(distinct(QualifiedRead.user_id)).label("n")).group_by(QualifiedRead.work_id)
        if ps:
            reads = reads.where(QualifiedRead.local_date >= ps)
        reads = reads.subquery()
        q = q.outerjoin(reads, reads.c.work_id == Work.id).order_by(func.coalesce(reads.c.n, 0).desc(), Work.id.desc())
    else:
        q = _apply_sort(q, f.get("sort", "new"))
    works = list((await db.scalars(q.offset(offset).limit(limit + 1))).all())
    more = len(works) > limit
    works = works[:limit]
    return {"items": await CardBuilder(db, user, ent).build(works), "next_cursor": encode_cursor(offset + limit) if more else None}


async def search(db: AsyncSession, user: User | None, ent: Entitlements, query: str, f: dict, limit: int = 20, cursor: str | None = None, in_text: bool = False) -> dict:
    """Search title, pen name, genre, tags and public synopsis with Latin/Cyrillic/apostrophe normalisation.

    Paid chapter text is never searched unless the user may read it (spec 7, 19.4).
    """
    nq = normalize_for_search(query)
    offset = decode_cursor(cursor)
    if not nq:
        return {"items": [], "next_cursor": None, "fuzzy": False, "query": query}
    terms = nq.split()[:8]
    base = _apply_filters(select(Work).where(catalog_visible_clause()), f, user)
    q = base.where(and_(*[Work.search_text.ilike(f"%{t}%") for t in terms])).order_by(
        func.similarity(Work.search_text, nq).desc(), Work.id.desc()
    )
    works = list((await db.scalars(q.offset(offset).limit(limit + 1))).all())
    fuzzy = False
    snippets: dict[int, str] = {}
    if not works and offset == 0:
        # careful "did you mean" results for typos (pg_trgm word similarity)
        fuzzy = True
        q = base.where(func.word_similarity(nq, Work.search_text) > 0.45).order_by(func.word_similarity(nq, Work.search_text).desc())
        works = list((await db.scalars(q.limit(limit))).all())
    if in_text and len(works) < limit:
        found = await _fulltext_accessible(db, ent, base, terms, exclude={w.id for w in works}, limit=limit - len(works))
        for w, snip in found:
            works.append(w)
            snippets[w.id] = snip
    more = len(works) > limit
    works = works[:limit]
    items = await CardBuilder(db, user, ent).build(works)
    for it in items:
        if it["id"] in snippets:
            it["snippet"] = snippets[it["id"]]
    return {"items": items, "next_cursor": encode_cursor(offset + limit) if more and not fuzzy else None, "fuzzy": fuzzy, "query": query}


async def _fulltext_accessible(db: AsyncSession, ent: Entitlements, base, terms: list[str], exclude: set[int], limit: int) -> list[tuple[Work, str]]:
    rows = (
        await db.execute(
            select(Work, Chapter, ChapterRevision.plain_text_for_index)
            .join(Chapter, Chapter.work_id == Work.id)
            .join(ChapterRevision, ChapterRevision.id == Chapter.published_revision_id)
            .where(Work.id.in_(base.with_only_columns(Work.id)), Chapter.is_deleted.is_(False))
            .where(and_(*[ChapterRevision.plain_text_for_index.ilike(f"%{t}%") for t in terms]))
            .limit(200)
        )
    ).all()
    out: list[tuple[Work, str]] = []
    now = utcnow()
    from app.services.access import decide_chapter_access

    for work, chapter, text in rows:
        if work.id in exclude or len(out) >= limit:
            continue
        if not decide_chapter_access(work, chapter, ent, now).full:
            continue  # no snippet / result from text the user may not read
        i = text.find(terms[0])
        out.append((work, "…" + text[max(0, i - 60) : i + 100] + "…"))
        exclude.add(work.id)
    return out


async def rankings(db: AsyncSession, user: User | None, ent: Entitlements, metric: str = "most_read", period: str = "week", genre: str | None = None, limit: int = 10) -> dict:
    """most_read = unique qualified readers in the calendar period (Asia/Tashkent). Not summed daily uniques."""
    key = f"rank:{metric}:{period}:{genre}:{limit}"
    cached = _cached(key, 30)
    if cached is None:
        visible = select(Work.id).where(catalog_visible_clause())
        if genre:
            visible = visible.where(Work.id.in_(select(WorkGenre.work_id).join(Genre, Genre.id == WorkGenre.genre_id).where(Genre.slug == genre)))
        if metric == "trend":
            now = utcnow()
            since, prev = now - timedelta(hours=24), now - timedelta(hours=48)
            r24 = select(QualifiedRead.work_id, func.count(distinct(QualifiedRead.user_id)).label("r")).where(QualifiedRead.qualified_at >= since).group_by(QualifiedRead.work_id).subquery()
            rprev = (
                select(QualifiedRead.work_id, func.count(distinct(QualifiedRead.user_id)).label("p"))
                .where(QualifiedRead.qualified_at >= prev, QualifiedRead.qualified_at < since)
                .group_by(QualifiedRead.work_id)
                .subquery()
            )
            f24 = select(Follow.target_id.label("work_id"), func.count().label("f")).where(Follow.target_type == "work", Follow.created_at >= since).group_by(Follow.target_id).subquery()
            c24 = select(ChapterCompletion.work_id, func.count(distinct(ChapterCompletion.user_id)).label("c")).where(ChapterCompletion.completed_at >= since).group_by(ChapterCompletion.work_id).subquery()
            score = (
                func.coalesce(r24.c.r, 0) + 0.5 * func.coalesce(f24.c.f, 0) + 0.7 * func.coalesce(c24.c.c, 0) - 0.5 * func.coalesce(rprev.c.p, 0)
            )
            q = (
                select(r24.c.work_id, score.label("score"), r24.c.r)
                .outerjoin(rprev, rprev.c.work_id == r24.c.work_id)
                .outerjoin(f24, f24.c.work_id == r24.c.work_id)
                .outerjoin(c24, c24.c.work_id == r24.c.work_id)
                .where(r24.c.work_id.in_(visible), r24.c.r >= 3)  # minimum sample
                .order_by(score.desc())
                .limit(limit)
            )
            rows = [(r[0], round(float(r[1]), 2)) for r in (await db.execute(q)).all()]
            formula = TREND_FORMULA
        elif metric == "thanks":
            rows = [(r[0], r[1]) for r in (await db.execute(select(Work.id, Work.thanks_count).where(Work.id.in_(visible), Work.thanks_count > 0).order_by(Work.thanks_count.desc()).limit(limit))).all()]
            formula = "thanks-v1"
        else:
            ps = period_start_date(period)
            q = select(QualifiedRead.work_id, func.count(distinct(QualifiedRead.user_id)).label("n")).where(QualifiedRead.work_id.in_(visible))
            if ps:
                q = q.where(QualifiedRead.local_date >= ps)
            q = q.group_by(QualifiedRead.work_id).order_by(func.count(distinct(QualifiedRead.user_id)).desc(), QualifiedRead.work_id).limit(limit)
            rows = [(r[0], r[1]) for r in (await db.execute(q)).all()]
            formula = MOST_READ_FORMULA
        cached = _cached(key, 30, {"rows": rows, "formula": formula})
    rows = cached["rows"]  # type: ignore[index]
    works = {w.id: w for w in (await db.scalars(select(Work).where(Work.id.in_([r[0] for r in rows])))).all()}
    ordered = [works[r[0]] for r in rows if r[0] in works]
    cards = await CardBuilder(db, user, ent).build(ordered)
    for i, (c, r) in enumerate(zip(cards, [r for r in rows if r[0] in works])):
        c["rank"] = i + 1
        c["score"] = r[1]
    return {
        "metric": metric,
        "period": period,
        "formula_version": cached["formula"],  # type: ignore[index]
        "period_note": {
            "today": "Bugun 00:00 dan (Toshkent vaqti)",
            "week": "Shu hafta, dushanba 00:00 dan",
            "month": "Shu oy, 1-kundan",
            "all": "Barcha vaqt",
        }.get(period, ""),
        "items": cards,
    }


async def genres_list(db: AsyncSession, script: str = "latn") -> list[dict]:
    rows = (await db.scalars(select(Genre).where(Genre.active.is_(True)).order_by(Genre.sort_order, Genre.id))).all()
    counts = dict(
        (await db.execute(select(WorkGenre.genre_id, func.count()).join(Work, Work.id == WorkGenre.work_id).where(catalog_visible_clause()).group_by(WorkGenre.genre_id))).all()
    )
    covers = await asset_urls(db, {g.cover_asset_id for g in rows if g.cover_asset_id})
    return [
        {"id": g.id, "slug": g.slug, "name": g.name_cyrl if script == "cyrl" else g.name_latn, "emoji": g.emoji, "count": counts.get(g.id, 0), "cover_url": covers.get(g.cover_asset_id or 0)}
        for g in rows
    ]


async def continue_items(db: AsyncSession, user: User, ent: Entitlements, limit: int = 3) -> list[dict]:
    rows = (
        await db.execute(
            select(ReadingProgress, Work)
            .join(Work, Work.id == ReadingProgress.work_id)
            .where(ReadingProgress.user_id == user.id, ReadingProgress.completion_state != "completed", Work.editorial_state.in_(("published", "delisted")))
            .order_by(ReadingProgress.updated_at.desc())
            .limit(limit)
        )
    ).all()
    cards = await CardBuilder(db, user, ent).build([r[1] for r in rows])
    chapters = {c.id: c for c in (await db.scalars(select(Chapter).where(Chapter.id.in_([r[0].chapter_id for r in rows])))).all()}
    for c, (p, _w) in zip(cards, rows):
        ch = chapters.get(p.chapter_id)
        c["continue"] = {"chapter_id": p.chapter_id, "chapter_title": ch.title if ch else "", "ratio": p.current_ratio, "block_id": p.current_block_id}
    return cards


async def new_chapters_items(db: AsyncSession, user: User, ent: Entitlements, limit: int = 10) -> list[dict]:
    """Unread new chapters in started or followed works, grouped per work («3 ta yangi bob»)."""
    started = select(ReadingProgress.work_id).where(ReadingProgress.user_id == user.id)
    followed = select(Follow.target_id).where(Follow.user_id == user.id, Follow.target_type == "work")
    done = select(ChapterCompletion.chapter_id).where(ChapterCompletion.user_id == user.id)
    since = utcnow() - timedelta(days=30)
    rows = (
        await db.execute(
            select(Chapter.work_id, func.count(Chapter.id), func.min(Chapter.id))
            .join(Work, Work.id == Chapter.work_id)
            .where(
                or_(Chapter.work_id.in_(started), Chapter.work_id.in_(followed)),
                Chapter.published_at >= since,
                Chapter.published_at <= utcnow(),
                Chapter.is_deleted.is_(False),
                Chapter.id.not_in(done),
                catalog_visible_clause(),
            )
            .group_by(Chapter.work_id)
            .order_by(func.max(Chapter.published_at).desc())
            .limit(limit)
        )
    ).all()
    # only count chapters published after the user's last read of that work
    works = {w.id: w for w in (await db.scalars(select(Work).where(Work.id.in_([r[0] for r in rows])))).all()}
    cards = await CardBuilder(db, user, ent).build([works[r[0]] for r in rows if r[0] in works])
    for c, r in zip(cards, [r for r in rows if r[0] in works]):
        c["new_chapters"] = r[1]
        c["first_new_chapter_id"] = r[2]
    return [c for c in cards if c.get("progress") is None or c["new_chapters"] > 0]


async def for_you(db: AsyncSession, user: User | None, ent: Entitlements, limit: int, exclude: set[int]) -> tuple[list[dict], str]:
    genre_ids: list[int] = list(user.favorite_genre_ids or []) if user else []
    if user:
        hist = (
            await db.scalars(
                select(WorkGenre.genre_id)
                .join(ReadingProgress, ReadingProgress.work_id == WorkGenre.work_id)
                .where(ReadingProgress.user_id == user.id)
                .group_by(WorkGenre.genre_id)
                .order_by(func.count().desc())
                .limit(5)
            )
        ).all()
        genre_ids = list(dict.fromkeys(genre_ids + list(hist)))
    q = select(Work).where(catalog_visible_clause())
    if user:
        q = q.where(
            Work.id.not_in(select(ReadingProgress.work_id).where(ReadingProgress.user_id == user.id)),
            Work.id.not_in(select(Dismissal.target_id).where(Dismissal.user_id == user.id, Dismissal.target_type == "work")),
            Work.id.not_in(
                select(WorkGenre.work_id).where(
                    WorkGenre.genre_id.in_(select(Dismissal.target_id).where(Dismissal.user_id == user.id, Dismissal.target_type == "genre"))
                )
            ),
        )
        if user.only_completed:
            q = q.where(Work.completion_state == "completed")
    if exclude:
        q = q.where(Work.id.not_in(exclude))
    basis = "editorial"
    if genre_ids:
        q2 = q.where(Work.id.in_(select(WorkGenre.work_id).where(WorkGenre.genre_id.in_(genre_ids)))).order_by(Work.thanks_count.desc(), Work.published_at.desc())
        works = list((await db.scalars(q2.limit(limit))).all())
        basis = "history"
    else:
        works = []
    if len(works) < limit:
        # not enough history: mix of different genres, newest first
        more = list((await db.scalars(q.where(Work.id.not_in([w.id for w in works] or [0])).order_by(Work.published_at.desc()).limit(limit * 3))).all())
        seen_genres: set[int | None] = set()
        for w in more:
            if len(works) >= limit:
                break
            if w.primary_genre_id in seen_genres and len(more) > limit:
                continue
            seen_genres.add(w.primary_genre_id)
            works.append(w)
        if basis != "history":
            basis = "diverse"
    return await CardBuilder(db, user, ent).build(works), basis


async def editorial_items(db: AsyncSession, user: User | None, ent: Entitlements, slug: str, limit: int) -> list[dict]:
    coll = await db.scalar(select(CuratedCollection).where(CuratedCollection.slug == slug, CuratedCollection.active.is_(True)))
    if coll is None:
        return []
    rows = (
        await db.execute(
            select(CuratedItem, Work).join(Work, Work.id == CuratedItem.work_id).where(CuratedItem.collection_id == coll.id, catalog_visible_clause()).order_by(CuratedItem.sort_key).limit(limit)
        )
    ).all()
    cards = await CardBuilder(db, user, ent).build([r[1] for r in rows])
    for c, (item, _w) in zip(cards, rows):
        c["reason"] = item.reason
        c["sponsored"] = item.sponsored
    return cards


async def section_items(db: AsyncSession, user: User | None, ent: Entitlements, sec: HomeSection, exclude: set[int]) -> dict:
    f = dict(sec.filter or {})
    lim = sec.max_items
    meta: dict = {}
    if sec.kind == "continue":
        items = await continue_items(db, user, ent, min(lim, 3)) if user else []
        if not items:
            meta["empty_hint"] = "Birinchi hikoyangizni tanlang"
            items, _ = await for_you(db, user, ent, 3, exclude)
            meta["starter"] = True
    elif sec.kind == "editorial":
        items = await editorial_items(db, user, ent, f.get("collection", "editors-choice"), min(lim, 3))
    elif sec.kind == "top":
        res = await rankings(db, user, ent, "most_read", f.get("period", "week"), f.get("genre"), min(lim, 10))
        items = res["items"]
        meta["period_note"] = res["period_note"]
        meta["formula_version"] = res["formula_version"]
    elif sec.kind == "for_you":
        items, basis = await for_you(db, user, ent, lim, exclude if not sec.allow_duplicates else set())
        meta["basis"] = basis
    elif sec.kind == "new_chapters":
        items = await new_chapters_items(db, user, ent, lim) if user else []
    elif sec.kind == "premium":
        res = await list_works(db, user, ent, {"access": "paid", "sort": "new", "respect_pref": True, "exclude_ids": list(exclude) if not sec.allow_duplicates else []}, lim)
        items = res["items"]
    elif sec.kind == "rail":
        if not sec.allow_duplicates:
            f["exclude_ids"] = list(exclude)
        res = await list_works(db, user, ent, f, lim)
        items = res["items"]
    else:
        items = []
    see_all = None
    if sec.kind in ("rail", "premium", "top"):
        see_all = {k: v for k, v in ({**f, "access": "paid"} if sec.kind == "premium" else f).items() if k != "exclude_ids"}
        if sec.kind == "top":
            see_all = {"sort": "popular", "period": f.get("period", "week")}
    return {"items": items, "see_all": see_all, **meta}


async def home(db: AsyncSession, user: User | None, ent: Entitlements, eager: int = 5) -> dict:
    now = utcnow()
    sections = (
        await db.scalars(
            select(HomeSection)
            .where(HomeSection.active.is_(True), or_(HomeSection.starts_at.is_(None), HomeSection.starts_at <= now), or_(HomeSection.ends_at.is_(None), HomeSection.ends_at > now))
            .order_by(HomeSection.sort_order, HomeSection.id)
        )
    ).all()
    script = user.script if user else "latn"
    out = []
    recent: list[set[int]] = []
    loaded = 0
    for sec in sections:
        entry: dict = {"key": sec.key, "kind": sec.kind, "title": sec.title_cyrl if script == "cyrl" and sec.title_cyrl else sec.title_latn, "items": None}
        if sec.kind in ("stories", "genres"):
            out.append(entry)
            continue
        if loaded < eager:
            exclude = set().union(*recent[-2:]) if recent else set()
            data = await section_items(db, user, ent, sec, exclude)
            entry.update(data)
            recent.append({it["id"] for it in data["items"]})
            loaded += 1
            if not data["items"] and sec.kind not in ("continue",):
                entry["empty"] = True
        out.append(entry)
    return {"sections": out, "genres": await genres_list(db, script)}


async def has_active_stories(db: AsyncSession) -> bool:
    now = utcnow()
    return bool(await db.scalar(select(AuthorStory.id).where(AuthorStory.status == "published", AuthorStory.expires_at > now).limit(1)))


def chapter_access_label(work: Work, chapter: Chapter, ent: Entitlements) -> str:
    pol = chapter_policy(work, chapter, utcnow())
    if pol == "FREE":
        return "free"
    if work.id in ent.work_ids or (ent.premium and pol in PREMIUM_POLICIES):
        return "open"
    return "locked"

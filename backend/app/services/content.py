"""Works, chapters, immutable revisions, editorial workflow and publishing.

The same functions are used by the Mini App studio API and by the bot (spec F-14, 14).
"""

from __future__ import annotations

import difflib
import secrets
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import content_schema as cs
from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.text import clean_plain, normalize_for_search, slugify, word_count
from app.core.timeutil import utcnow
from app.models import (
    Asset,
    AssetLink,
    AuthorProfile,
    Chapter,
    ChapterRevision,
    EditorialReview,
    Genre,
    PublishJob,
    Tag,
    Work,
    WorkContributor,
    WorkGenre,
    WorkTag,
)
from app.services.events import emit
from app.services.identity import (
    Actor,
    audit,
    can_publish_work,
    can_review_work,
    ensure_author_profile,
    require_edit_work,
)

FORMATS = {"short", "novella", "novel", "series", "diary"}
COMPLETION = {"ongoing", "completed", "paused"}
POLICIES = {"FREE", "PREMIUM", "PURCHASE", "PREMIUM_OR_PURCHASE"}
CHAPTER_OVERRIDES = {"inherit", "free_sample", "free_after", "locked_until"}
SCRIPTS = {"latn", "cyrl"}
EDITABLE_META = {
    "title", "synopsis", "format", "completion_state", "script", "comments_policy", "planned_chapters",
    "next_release_at", "next_release_note", "recap_note", "content_flags", "cover_asset_id",
}


def _short_code() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


async def get_work(db: AsyncSession, work_id: int, *, for_update: bool = False) -> Work:
    q = select(Work).where(Work.id == work_id)
    if for_update:
        q = q.with_for_update()
    w = await db.scalar(q)
    if w is None:
        raise NotFound("Asar topilmadi")
    return w


async def get_work_by_code(db: AsyncSession, code: str) -> Work | None:
    return await db.scalar(select(Work).where(Work.short_code == code))


async def get_chapter(db: AsyncSession, chapter_id: int, *, for_update: bool = False) -> Chapter:
    q = select(Chapter).where(Chapter.id == chapter_id, Chapter.is_deleted.is_(False))
    if for_update:
        q = q.with_for_update()
    c = await db.scalar(q)
    if c is None:
        raise NotFound("Bob topilmadi")
    return c


async def refresh_search_text(db: AsyncSession, work: Work) -> None:
    names = (
        await db.scalars(
            select(AuthorProfile.pen_name)
            .join(WorkContributor, WorkContributor.author_id == AuthorProfile.id, isouter=True)
            .where((AuthorProfile.id == work.primary_author_id) | (WorkContributor.work_id == work.id))
        )
    ).all()
    genres = (
        await db.execute(
            select(Genre.name_latn, Genre.synonyms).join(WorkGenre, WorkGenre.genre_id == Genre.id).where(WorkGenre.work_id == work.id)
        )
    ).all()
    tags = (await db.scalars(select(Tag.name_latn).join(WorkTag, WorkTag.tag_id == Tag.id).where(WorkTag.work_id == work.id))).all()
    parts = [work.title, " ".join(set(names)), " ".join(g[0] + " " + " ".join(g[1] or []) for g in genres), " ".join(tags), work.synopsis]
    work.search_text = normalize_for_search(" ".join(parts))


async def set_genres(db: AsyncSession, work: Work, primary_genre_id: int | None, genre_ids: list[int]) -> None:
    ids = list(dict.fromkeys(([primary_genre_id] if primary_genre_id else []) + list(genre_ids)))[:5]
    if ids:
        found = set((await db.scalars(select(Genre.id).where(Genre.id.in_(ids), Genre.active.is_(True)))).all())
        if len(found) != len(ids):
            raise Invalid("Janr topilmadi", code="genre_invalid")
    await db.execute(WorkGenre.__table__.delete().where(WorkGenre.work_id == work.id))
    for gid in ids:
        db.add(WorkGenre(work_id=work.id, genre_id=gid, is_primary=gid == primary_genre_id))
    work.primary_genre_id = primary_genre_id or (ids[0] if ids else None)


async def set_tags(db: AsyncSession, work: Work, tag_ids: list[int]) -> None:
    await db.execute(WorkTag.__table__.delete().where(WorkTag.work_id == work.id))
    for tid in list(dict.fromkeys(tag_ids))[:12]:
        db.add(WorkTag(work_id=work.id, tag_id=tid))


async def resolve_author_for_create(db: AsyncSession, actor: Actor, author_id: int | None) -> AuthorProfile:
    if author_id and author_id != actor.own_author_id:
        if author_id not in actor.author_ids and not actor.has("author.post_as"):
            raise Forbidden("Boshqa muallif nomidan joylash vakolati yo'q", code="post_as_denied")
        prof = await db.get(AuthorProfile, author_id)
        if prof is None:
            raise NotFound("Muallif topilmadi")
        return prof
    return await ensure_author_profile(db, actor.user)


async def create_work(
    db: AsyncSession,
    actor: Actor,
    *,
    title: str,
    synopsis: str = "",
    author_id: int | None = None,
    format: str = "short",
    script: str = "latn",
    completion_state: str = "ongoing",
    primary_genre_id: int | None = None,
    genre_ids: list[int] | None = None,
    tag_ids: list[int] | None = None,
    access_policy: str = "FREE",
    content_flags: dict | None = None,
    is_demo: bool = False,
) -> Work:
    actor.require("work.create")
    title = clean_plain(title, 200)
    if not title:
        raise Invalid("Sarlavha kerak", code="title_required")
    if format not in FORMATS or script not in SCRIPTS or completion_state not in COMPLETION:
        raise Invalid("Noto'g'ri tasnif", code="classification_invalid")
    author = await resolve_author_for_create(db, actor, author_id)
    flags = dict(content_flags or {})
    policy = "FREE"
    if access_policy not in POLICIES:
        raise Invalid("Noto'g'ri kirish siyosati", code="policy_invalid")
    if access_policy != "FREE":
        if actor.has("work.change_access"):
            policy = access_policy
        else:
            flags["requested_access"] = access_policy  # admin decides during review
    code = _short_code()
    while await db.scalar(select(Work.id).where(Work.short_code == code)):
        code = _short_code()
    work = Work(
        short_code=code,
        slug=slugify(title),
        title=title,
        synopsis=clean_plain(synopsis, 4000),
        primary_author_id=author.id,
        format=format,
        script=script,
        completion_state=completion_state,
        access_policy=policy,
        content_flags=flags,
        created_by_user_id=actor.id,
        is_demo=is_demo,
    )
    db.add(work)
    await db.flush()
    db.add(WorkContributor(work_id=work.id, author_id=author.id, contribution_type="author"))
    await set_genres(db, work, primary_genre_id, genre_ids or [])
    if tag_ids:
        await set_tags(db, work, tag_ids)
    await db.flush()
    await refresh_search_text(db, work)
    on_behalf = author.id if author.user_id != actor.id else None
    await audit(db, actor, "work.create", "work", work.id, after={"title": title, "author_id": author.id}, on_behalf_of_author_id=on_behalf)
    return work


async def update_work_meta(db: AsyncSession, actor: Actor, work: Work, patch: dict, expected_version: int | None = None) -> Work:
    await require_edit_work(db, actor, work)
    if expected_version is not None and expected_version != work.version:
        raise Conflict("Asar boshqa joyda o'zgartirilgan", code="version_conflict", current_version=work.version)
    before = {k: getattr(work, k) for k in patch if hasattr(work, k) and k in EDITABLE_META}
    for k, v in patch.items():
        if k not in EDITABLE_META:
            continue
        if k == "title":
            v = clean_plain(v, 200)
            if not v:
                raise Invalid("Sarlavha kerak", code="title_required")
            work.slug = slugify(v)
        elif k in ("synopsis", "next_release_note", "recap_note"):
            v = clean_plain(v, 4000)
        elif k == "format" and v not in FORMATS:
            raise Invalid("Noto'g'ri format", code="classification_invalid")
        elif k == "completion_state" and v not in COMPLETION:
            raise Invalid("Noto'g'ri holat", code="classification_invalid")
        elif k == "script" and v not in SCRIPTS:
            raise Invalid("Noto'g'ri yozuv", code="classification_invalid")
        elif k == "cover_asset_id" and v is not None:
            asset = await db.get(Asset, int(v))
            if asset is None or asset.kind != "image":
                raise Invalid("Muqova rasm bo'lishi kerak", code="cover_invalid")
            asset.visibility = "public"
        elif k == "content_flags":
            v = {**(work.content_flags or {}), **{kk: vv for kk, vv in (v or {}).items() if kk in ("age_rating", "author_claim", "mood", "illustrated")}}
        setattr(work, k, v)
    was_completed = before.get("completion_state")
    if "genre_ids" in patch or "primary_genre_id" in patch:
        await set_genres(db, work, patch.get("primary_genre_id", work.primary_genre_id), patch.get("genre_ids", []))
    if "tag_ids" in patch:
        await set_tags(db, work, patch["tag_ids"])
    work.version += 1
    await db.flush()
    await refresh_search_text(db, work)
    await audit(db, actor, "work.update_meta", "work", work.id, before=_jsonable(before), after=_jsonable({k: patch[k] for k in patch if k in EDITABLE_META}))
    if was_completed and was_completed != "completed" and work.completion_state == "completed" and work.editorial_state == "published":
        await emit(db, f"work.completed:{work.id}", "work.completed", {"work_id": work.id})
    return work


async def change_access_policy(db: AsyncSession, actor: Actor, work: Work, policy: str, reason: str = "") -> Work:
    actor.require("work.change_access")
    if policy not in POLICIES:
        raise Invalid("Noto'g'ri kirish siyosati", code="policy_invalid")
    before = work.access_policy
    work.access_policy = policy
    flags = dict(work.content_flags or {})
    flags.pop("requested_access", None)
    work.content_flags = flags
    work.version += 1
    await audit(db, actor, "work.change_access", "work", work.id, before={"access_policy": before}, after={"access_policy": policy}, reason=reason)
    return work


def _jsonable(d: dict) -> dict:
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in d.items()}


async def list_chapters(db: AsyncSession, work_id: int) -> list[Chapter]:
    return list(
        (await db.scalars(select(Chapter).where(Chapter.work_id == work_id, Chapter.is_deleted.is_(False)).order_by(Chapter.sort_key))).all()
    )


async def _new_revision(
    db: AsyncSession, chapter: Chapter, doc: dict, editor_id: int | None, parent_id: int | None, note: str = ""
) -> ChapterRevision:
    text = cs.plain_text(doc)
    rev = ChapterRevision(
        chapter_id=chapter.id,
        parent_revision_id=parent_id,
        content_json=doc,
        plain_text_for_index=normalize_for_search(text)[:200_000],
        content_hash=cs.content_hash(doc),
        editor_id=editor_id,
        change_note=clean_plain(note, 500),
        word_count=word_count(text),
        block_ids=cs.block_ids(doc),
    )
    db.add(rev)
    await db.flush()
    return rev


async def add_chapter(
    db: AsyncSession,
    actor: Actor,
    work: Work,
    *,
    title: str = "",
    doc: dict | None = None,
    access_override: str = "inherit",
    after_chapter_id: int | None = None,
) -> Chapter:
    await require_edit_work(db, actor, work)
    if access_override not in CHAPTER_OVERRIDES:
        raise Invalid("Noto'g'ri bob siyosati", code="policy_invalid")
    max_sort = await db.scalar(select(func.max(Chapter.sort_key)).where(Chapter.work_id == work.id, Chapter.is_deleted.is_(False)))
    sort_key = (max_sort or 0) + 1024
    if after_chapter_id:
        after = await get_chapter(db, after_chapter_id)
        nxt = await db.scalar(
            select(func.min(Chapter.sort_key)).where(Chapter.work_id == work.id, Chapter.sort_key > after.sort_key, Chapter.is_deleted.is_(False))
        )
        sort_key = (after.sort_key + nxt) / 2 if nxt else after.sort_key + 1024
    count = await db.scalar(select(func.count()).select_from(Chapter).where(Chapter.work_id == work.id, Chapter.is_deleted.is_(False)))
    ch = Chapter(
        work_id=work.id,
        stable_key=secrets.token_hex(6),
        sort_key=sort_key,
        title=clean_plain(title, 200) or f"{(count or 0) + 1}-bob",
        access_override=access_override,
    )
    db.add(ch)
    await db.flush()
    if doc is not None:
        rev = await _new_revision(db, ch, cs.sanitize_doc(doc), actor.id, None, "Birinchi qoralama")
        ch.draft_revision_id = rev.id
        ch.words = rev.word_count
    await audit(db, actor, "chapter.create", "chapter", ch.id, after={"work_id": work.id, "title": ch.title})
    return ch


async def current_editable_revision_id(chapter: Chapter) -> int | None:
    return chapter.draft_revision_id or chapter.published_revision_id


async def save_revision(
    db: AsyncSession, actor: Actor, chapter: Chapter, doc: dict, base_revision_id: int | None, note: str = ""
) -> ChapterRevision:
    """Save a new draft revision. Concurrent edits with a stale base return 409 (T-32)."""
    chapter = await get_chapter(db, chapter.id, for_update=True)
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    head = await current_editable_revision_id(chapter)
    if head != base_revision_id:
        raise Conflict(
            "Matn boshqa muharrir tomonidan o'zgartirilgan. Sizning matningiz saqlanmadi, lekin yo'qolmadi.",
            code="revision_conflict",
            current_revision_id=head,
        )
    clean = cs.sanitize_doc(doc)
    if head:
        head_rev = await db.get(ChapterRevision, head)
        if head_rev and head_rev.content_hash == cs.content_hash(clean):
            return head_rev
    rev = await _new_revision(db, chapter, clean, actor.id, head, note)
    chapter.draft_revision_id = rev.id
    # An edit after approval needs review again. A published chapter keeps state "published":
    # readers keep getting published_revision_id until the new draft is published (T-31).
    # A scheduled job keeps pointing at the revision that was approved, never at this new draft.
    if chapter.editorial_state in ("approved", "in_review", "changes_requested"):
        chapter.editorial_state = "draft"
    return rev


async def update_chapter_meta(db: AsyncSession, actor: Actor, chapter: Chapter, patch: dict) -> Chapter:
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    if "title" in patch:
        chapter.title = clean_plain(patch["title"], 200) or chapter.title
    if "access_override" in patch:
        if patch["access_override"] not in CHAPTER_OVERRIDES:
            raise Invalid("Noto'g'ri bob siyosati", code="policy_invalid")
        changes_paid_access = patch["access_override"] != chapter.access_override and work.access_policy != "FREE"
        if changes_paid_access and not await can_publish_work(db, actor, work):
            actor.require("work.change_access")
        chapter.access_override = patch["access_override"]
    for k in ("free_after_at", "release_at"):
        if k in patch:
            setattr(chapter, k, patch[k])
    if "preview_blocks" in patch:
        chapter.preview_blocks = max(0, min(int(patch["preview_blocks"]), 30))
    await audit(db, actor, "chapter.update_meta", "chapter", chapter.id, after=_jsonable(patch))
    return chapter


async def reorder_chapters(db: AsyncSession, actor: Actor, work: Work, chapter_ids: list[int]) -> None:
    await require_edit_work(db, actor, work)
    chapters = {c.id: c for c in await list_chapters(db, work.id)}
    if set(chapter_ids) != set(chapters):
        raise Invalid("Boblar ro'yxati to'liq emas", code="reorder_invalid")
    for i, cid in enumerate(chapter_ids):
        chapters[cid].sort_key = (i + 1) * 1024
    await audit(db, actor, "chapter.reorder", "work", work.id, after={"order": chapter_ids})


async def delete_chapter(db: AsyncSession, actor: Actor, chapter: Chapter) -> None:
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    if chapter.published_revision_id and not await can_publish_work(db, actor, work):
        raise Forbidden("Nashr qilingan bobni olib tashlash uchun nashr vakolati kerak", code="permission_denied")
    chapter.is_deleted = True
    await recompute_work_counters(db, work)
    await audit(db, actor, "chapter.delete", "chapter", chapter.id)


async def technical_check(db: AsyncSession, work: Work, chapters: list[Chapter]) -> list[dict]:
    """Pre-publish checks: empty chapter, missing/broken cover, assets not ready (spec 16)."""
    problems: list[dict] = []
    if not work.title.strip():
        problems.append({"code": "no_title", "message": "Sarlavha yo'q"})
    if work.cover_asset_id:
        cover = await db.get(Asset, work.cover_asset_id)
        if cover is None or cover.kind != "image" or cover.processing_state != "ready":
            problems.append({"code": "bad_cover", "message": "Muqova noto'g'ri yoki tayyor emas"})
    if not chapters:
        problems.append({"code": "no_chapters", "message": "Asarda bob yo'q"})
    for ch in chapters:
        rid = ch.draft_revision_id or ch.published_revision_id
        rev = await db.get(ChapterRevision, rid) if rid else None
        if rev is None or rev.word_count == 0:
            problems.append({"code": "empty_chapter", "chapter_id": ch.id, "message": f"«{ch.title}» bo'sh"})
            continue
        for aid in cs.asset_ids(rev.content_json):
            a = await db.get(Asset, aid)
            if a is None or a.processing_state != "ready":
                problems.append({"code": "asset_not_ready", "chapter_id": ch.id, "message": f"«{ch.title}» ichidagi rasm tayyor emas"})
    return problems


async def submit_for_review(db: AsyncSession, actor: Actor, work: Work, chapter_ids: list[int] | None = None, note: str = "") -> list[EditorialReview]:
    await require_edit_work(db, actor, work)
    chapters = [c for c in await list_chapters(db, work.id) if c.draft_revision_id and (not chapter_ids or c.id in chapter_ids)]
    if not chapters and work.editorial_state in ("draft", "changes_requested"):
        raise Invalid("Tekshiruvga yuboriladigan matn yo'q", code="nothing_to_submit")
    problems = await technical_check(db, work, chapters or await list_chapters(db, work.id))
    if problems:
        raise Invalid("Nashrdan oldingi tekshiruv xatolari bor", code="technical_check_failed", problems=problems)
    reviews = []
    for ch in chapters:
        ch.editorial_state = "in_review"
        r = EditorialReview(work_id=work.id, chapter_id=ch.id, revision_id=ch.draft_revision_id, submitted_by=actor.id, note=clean_plain(note, 1000))
        db.add(r)
        reviews.append(r)
    if work.editorial_state in ("draft", "changes_requested", "unpublished"):
        work.editorial_state = "in_review"
    await db.flush()
    await audit(db, actor, "work.submit_review", "work", work.id, after={"chapters": [c.id for c in chapters]})
    await emit(db, f"review.submitted:{work.id}:{','.join(str(r.id) for r in reviews)}", "review.submitted", {"work_id": work.id})
    return reviews


async def decide_review(db: AsyncSession, actor: Actor, review: EditorialReview, decision: str, note: str = "") -> EditorialReview:
    work = await get_work(db, review.work_id)
    if not await can_review_work(db, actor, work):
        raise Forbidden("Tekshirish vakolati yo'q", code="permission_denied")
    if review.decision != "pending":
        raise Conflict("Bu so'rov allaqachon ko'rib chiqilgan", code="already_decided")
    if decision not in ("approved", "changes_requested"):
        raise Invalid("Noto'g'ri qaror", code="decision_invalid")
    review.decision = decision
    review.reviewer_id = actor.id
    review.note = clean_plain(note, 2000) or review.note
    review.decided_at = utcnow()
    if review.chapter_id:
        ch = await get_chapter(db, review.chapter_id)
        if ch.draft_revision_id != review.revision_id:
            raise Conflict("Matn tekshiruvdan keyin o'zgargan", code="revision_changed")
        ch.editorial_state = "approved" if decision == "approved" else "changes_requested"
    if decision == "changes_requested" and work.editorial_state == "in_review":
        work.editorial_state = "changes_requested"
    elif decision == "approved" and work.editorial_state == "in_review":
        work.editorial_state = "approved"
    await audit(db, actor, f"review.{decision}", "work", work.id, after={"review_id": review.id, "note": note})
    await emit(db, f"review.decided:{review.id}", "review.decided", {"work_id": work.id, "review_id": review.id, "decision": decision})
    return review


async def _assert_can_publish(db: AsyncSession, actor: Actor, work: Work, chapters: list[Chapter]) -> None:
    if await can_publish_work(db, actor, work):
        return
    if all(c.editorial_state == "approved" for c in chapters) and await can_review_work(db, actor, work):
        return
    raise Forbidden("Nashr qilish uchun tasdiq yoki vakolat kerak", code="publish_denied")


async def apply_publish(db: AsyncSession, work: Work, chapter: Chapter, revision_id: int, now: datetime | None = None) -> bool:
    """Make ``revision_id`` the published revision. Idempotent: returns False if already published."""
    now = now or utcnow()
    if chapter.published_revision_id == revision_id and chapter.published_at:
        return False
    first_time = chapter.published_revision_id is None
    chapter.published_revision_id = revision_id
    if chapter.draft_revision_id == revision_id:
        chapter.draft_revision_id = None
    chapter.editorial_state = "published"
    chapter.published_at = chapter.published_at or now
    rev = await db.get(ChapterRevision, revision_id)
    chapter.words = rev.word_count if rev else chapter.words
    if work.editorial_state not in ("published", "delisted", "suspended"):
        work.editorial_state = "published"
    work.published_at = work.published_at or now
    if first_time:
        work.last_chapter_published_at = now
    await recompute_work_counters(db, work)
    await emit(
        db,
        f"chapter.published:{chapter.id}:{revision_id}",
        "chapter.published",
        {"work_id": work.id, "chapter_id": chapter.id, "revision_id": revision_id, "first_time": first_time},
    )
    return True


async def publish_now(db: AsyncSession, actor: Actor, work: Work, chapter_ids: list[int] | None = None) -> list[Chapter]:
    await require_edit_work(db, actor, work)
    chapters = [c for c in await list_chapters(db, work.id) if c.draft_revision_id and (not chapter_ids or c.id in chapter_ids)]
    if not chapters:
        if work.editorial_state in ("unpublished", "approved") and any(c.published_revision_id for c in await list_chapters(db, work.id)):
            await _assert_can_publish(db, actor, work, [])
            work.editorial_state = "published"
            await audit(db, actor, "work.republish", "work", work.id)
            return []
        raise Invalid("Nashr qilinadigan yangi matn yo'q", code="nothing_to_publish")
    await _assert_can_publish(db, actor, work, chapters)
    problems = await technical_check(db, work, chapters)
    if problems:
        raise Invalid("Nashrdan oldingi tekshiruv xatolari bor", code="technical_check_failed", problems=problems)
    now = utcnow()
    for ch in chapters:
        await _cancel_jobs(db, ch.id)
        await apply_publish(db, work, ch, ch.draft_revision_id, now)  # type: ignore[arg-type]
    await audit(db, actor, "work.publish", "work", work.id, after={"chapters": [c.id for c in chapters]})
    return chapters


async def _cancel_jobs(db: AsyncSession, chapter_id: int) -> None:
    await db.execute(
        update(PublishJob).where(PublishJob.chapter_id == chapter_id, PublishJob.status == "pending").values(status="canceled", finished_at=utcnow())
    )


async def schedule_publish(db: AsyncSession, actor: Actor, chapter: Chapter, run_at: datetime) -> PublishJob:
    """Schedule the current approved draft. Rescheduling cancels the previous job (T-35)."""
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    if run_at.tzinfo is None:
        raise Invalid("Vaqt zonasi ko'rsatilmagan", code="tz_required")
    if run_at <= utcnow():
        raise Invalid("Vaqt kelajakda bo'lishi kerak", code="time_in_past")
    if not chapter.draft_revision_id:
        raise Invalid("Rejalashtiriladigan qoralama yo'q", code="nothing_to_publish")
    await _assert_can_publish(db, actor, work, [chapter])
    prev_version = await db.scalar(select(func.max(PublishJob.job_version)).where(PublishJob.chapter_id == chapter.id)) or 0
    await _cancel_jobs(db, chapter.id)
    job = PublishJob(
        work_id=work.id,
        chapter_id=chapter.id,
        revision_id=chapter.draft_revision_id,
        access_snapshot={"work_policy": work.access_policy, "chapter_override": chapter.access_override},
        run_at=run_at,
        job_version=prev_version + 1,
        created_by=actor.id,
    )
    db.add(job)
    chapter.editorial_state = "scheduled"
    if work.editorial_state in ("draft", "approved", "in_review", "changes_requested"):
        work.editorial_state = "scheduled" if not work.published_at else work.editorial_state
    await db.flush()
    await audit(db, actor, "chapter.schedule", "chapter", chapter.id, after={"run_at": run_at.isoformat(), "revision_id": job.revision_id})
    return job


async def cancel_schedule(db: AsyncSession, actor: Actor, chapter: Chapter) -> None:
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    await _cancel_jobs(db, chapter.id)
    if chapter.editorial_state == "scheduled":
        chapter.editorial_state = "approved"
    await audit(db, actor, "chapter.unschedule", "chapter", chapter.id)


async def run_publish_job(db: AsyncSession, job_id: int) -> str:
    """Execute a publish job exactly once even if two workers pick it up (T-34)."""
    claimed = await db.execute(
        update(PublishJob)
        .where(PublishJob.id == job_id, PublishJob.status == "pending")
        .values(status="running", attempts=PublishJob.attempts + 1)
        .returning(PublishJob.id)
    )
    if claimed.scalar() is None:
        return "skipped"
    job = await db.get(PublishJob, job_id)
    assert job is not None
    chapter = await db.get(Chapter, job.chapter_id) if job.chapter_id else None
    work = await db.get(Work, job.work_id)
    if chapter is None or work is None or chapter.is_deleted:
        job.status, job.last_error, job.finished_at = "failed", "Bob topilmadi", utcnow()
        return "failed"
    # never publish some other draft than the approved revision in the job
    rev = await db.get(ChapterRevision, job.revision_id) if job.revision_id else None
    if rev is None or rev.chapter_id != chapter.id:
        job.status, job.last_error, job.finished_at = "failed", "Revision topilmadi", utcnow()
        return "failed"
    problems = await technical_check(db, work, [chapter])
    problems = [p for p in problems if p.get("chapter_id") in (None, chapter.id)]
    if problems:
        job.status, job.last_error, job.finished_at = "failed", "; ".join(p["message"] for p in problems), utcnow()
        chapter.editorial_state = "approved"
        await emit(db, f"publish.failed:{job.id}", "publish.failed", {"job_id": job.id, "work_id": work.id, "problems": problems})
        return "failed"
    await apply_publish(db, work, chapter, rev.id)
    job.status, job.finished_at = "done", utcnow()
    return "done"


async def set_work_state(db: AsyncSession, actor: Actor, work: Work, action: str, reason: str = "") -> Work:
    """unpublish | delist | relist | archive | restore | suspend | unsuspend."""
    before = {"editorial_state": work.editorial_state, "visibility": work.visibility}
    if action == "suspend" or action == "unsuspend":
        actor.require("work.suspend")
        if action == "suspend":
            if not reason.strip():
                raise Invalid("Sabab kerak", code="reason_required")
            work.content_flags = {**(work.content_flags or {}), "state_before_suspend": work.editorial_state}
            work.editorial_state, work.suspended_reason = "suspended", clean_plain(reason, 1000)
        else:
            work.editorial_state = (work.content_flags or {}).get("state_before_suspend", "published")
            work.suspended_reason = ""
    elif action in ("delist", "relist"):
        if not actor.has("work.delist"):
            await require_edit_work(db, actor, work)
            if not await can_publish_work(db, actor, work):
                raise Forbidden("Vakolat yo'q", code="permission_denied")
        if action == "delist":
            work.editorial_state, work.visibility = "delisted", "delisted"
        else:
            work.editorial_state, work.visibility = "published", "public"
    elif action == "unpublish":
        await require_edit_work(db, actor, work)
        if not await can_publish_work(db, actor, work):
            raise Forbidden("Vakolat yo'q", code="permission_denied")
        work.editorial_state = "unpublished"
    elif action == "archive":
        await require_edit_work(db, actor, work)
        work.content_flags = {**(work.content_flags or {}), "state_before_archive": work.editorial_state}
        work.editorial_state, work.archived_at = "archived", utcnow()
    elif action == "restore":
        await require_edit_work(db, actor, work)
        if work.editorial_state != "archived":
            raise Invalid("Asar arxivda emas", code="not_archived")
        if work.archived_at and utcnow() - work.archived_at > timedelta(days=30) and not actor.has("work.edit_any"):
            raise Forbidden("30 kunlik tiklash muddati o'tgan, administratorga murojaat qiling", code="restore_window_passed")
        work.editorial_state = (work.content_flags or {}).get("state_before_archive", "draft")
        work.archived_at = None
    else:
        raise Invalid("Noma'lum amal", code="action_invalid")
    work.version += 1
    await audit(db, actor, f"work.{action}", "work", work.id, before=before, after={"editorial_state": work.editorial_state, "visibility": work.visibility}, reason=reason)
    return work


async def list_revisions(db: AsyncSession, actor: Actor, chapter: Chapter) -> list[ChapterRevision]:
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    return list((await db.scalars(select(ChapterRevision).where(ChapterRevision.chapter_id == chapter.id).order_by(ChapterRevision.id.desc()))).all())


async def get_revision_for_editor(db: AsyncSession, actor: Actor, revision_id: int) -> tuple[ChapterRevision, Chapter, Work]:
    rev = await db.get(ChapterRevision, revision_id)
    if rev is None:
        raise NotFound("Nusxa topilmadi")
    chapter = await get_chapter(db, rev.chapter_id)
    work = await get_work(db, chapter.work_id)
    await require_edit_work(db, actor, work)
    return rev, chapter, work


def diff_revisions(a: ChapterRevision | None, b: ChapterRevision) -> list[dict]:
    """Block-level diff between two revisions (by stable id), with word-level detail for changed blocks."""
    a_blocks = {bl["attrs"]["bid"]: cs.block_text(bl) for bl in (a.content_json.get("content", []) if a else [])}
    out: list[dict] = []
    seen = set()
    for bl in b.content_json.get("content", []):
        bid = bl["attrs"]["bid"]
        seen.add(bid)
        new_text = cs.block_text(bl)
        if bid not in a_blocks:
            out.append({"bid": bid, "op": "added", "text": new_text})
        elif a_blocks[bid] != new_text:
            sm = difflib.SequenceMatcher(None, a_blocks[bid].split(" "), new_text.split(" "))
            parts = []
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == "equal":
                    parts.append({"t": "eq", "s": " ".join(sm.a[i1:i2])})
                else:
                    if i2 > i1:
                        parts.append({"t": "del", "s": " ".join(sm.a[i1:i2])})
                    if j2 > j1:
                        parts.append({"t": "ins", "s": " ".join(sm.b[j1:j2])})
            out.append({"bid": bid, "op": "changed", "parts": parts})
    for bid, text in a_blocks.items():
        if bid not in seen:
            out.append({"bid": bid, "op": "removed", "text": text})
    return out


async def restore_revision(db: AsyncSession, actor: Actor, chapter: Chapter, revision_id: int, publish: bool = False) -> ChapterRevision:
    """Rollback creates a NEW revision copied from the old one; history is never deleted (T-33)."""
    old, ch, work = await get_revision_for_editor(db, actor, revision_id)
    if old.chapter_id != chapter.id:
        raise Invalid("Nusxa bu bobga tegishli emas", code="revision_mismatch")
    head = await current_editable_revision_id(ch)
    rev = await _new_revision(db, ch, old.content_json, actor.id, head, f"#{old.id} nusxasiga qaytarildi")
    ch.draft_revision_id = rev.id
    await audit(db, actor, "chapter.restore_revision", "chapter", ch.id, after={"from_revision": old.id, "new_revision": rev.id})
    if publish:
        await _assert_can_publish(db, actor, work, [ch])
        await apply_publish(db, work, ch, rev.id)
        await audit(db, actor, "chapter.publish_restored", "chapter", ch.id, after={"revision_id": rev.id})
    return rev


async def recompute_work_counters(db: AsyncSession, work: Work) -> None:
    await db.flush()
    rows = (
        await db.execute(
            select(func.count(Chapter.id), func.coalesce(func.sum(Chapter.words), 0), func.bool_or(Chapter.has_audio), func.max(Chapter.published_at)).where(
                Chapter.work_id == work.id, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None)
            )
        )
    ).one()
    work.chapters_published = rows[0] or 0
    work.words_published = int(rows[1] or 0)
    has_audio_link = await db.scalar(
        select(func.count(AssetLink.id)).where(
            AssetLink.purpose == "audio",
            ((AssetLink.target_type == "work") & (AssetLink.target_id == work.id))
            | ((AssetLink.target_type == "chapter") & AssetLink.target_id.in_(select(Chapter.id).where(Chapter.work_id == work.id))),
        )
    )
    work.has_audio = bool(rows[2]) or bool(has_audio_link)
    if rows[3]:
        work.last_chapter_published_at = max(rows[3], work.last_chapter_published_at or rows[3])

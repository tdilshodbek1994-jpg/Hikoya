"""Likes, free thanks, follows, comments with spoiler rules, reports and moderation (spec 11)."""

from __future__ import annotations

import re
from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import AccessRequired, Conflict, Forbidden, Invalid, NotFound
from app.core.text import clean_plain
from app.core.timeutil import utcnow
from app.models import (
    AuthorProfile,
    Chapter,
    ChapterCompletion,
    Comment,
    CommentVote,
    Follow,
    Like,
    ModerationAction,
    ReadingProgress,
    Report,
    Thanks,
    User,
    UserRestriction,
    Work,
)
from app.services.access import Entitlements, decide_chapter_access
from app.services.events import emit
from app.services.identity import Actor, audit, is_work_author

THANKS_REASONS = {"", "touched", "useful", "waiting"}
REPORT_REASONS = {"spam", "abuse", "ads", "personal_data", "plagiarism", "spoiler", "other"}
_LINK_RE = re.compile(r"(https?://|t\.me/|www\.)", re.I)


async def set_like(db: AsyncSession, user: User, work: Work, on: bool) -> dict:
    """Idempotent: repeating the same request never changes the counter twice (T-18)."""
    if on:
        res = await db.execute(insert(Like).values(user_id=user.id, work_id=work.id).on_conflict_do_nothing().returning(Like.work_id))
        if res.scalar() is not None:
            await db.execute(update(Work).where(Work.id == work.id).values(likes_count=Work.likes_count + 1))
    else:
        res = await db.execute(delete(Like).where(Like.user_id == user.id, Like.work_id == work.id).returning(Like.work_id))
        if res.scalar() is not None:
            await db.execute(update(Work).where(Work.id == work.id).values(likes_count=func.greatest(Work.likes_count - 1, 0)))
    count = await db.scalar(select(Work.likes_count).where(Work.id == work.id))
    return {"liked": on, "likes": count}


async def set_thanks(db: AsyncSession, user: User, work: Work, on: bool, reason: str = "") -> dict:
    """Free «Muallifga rahmat». Never creates an invoice (T-19). One per user+work (T-20)."""
    if reason not in THANKS_REASONS:
        raise Invalid("Noto'g'ri sabab", code="reason_invalid")
    existing = await db.scalar(select(Thanks).where(Thanks.user_id == user.id, Thanks.work_id == work.id).with_for_update())
    delta = 0
    if on:
        if existing is None:
            res = await db.execute(insert(Thanks).values(user_id=user.id, work_id=work.id, reason=reason, active=True).on_conflict_do_nothing().returning(Thanks.work_id))
            delta = 1 if res.scalar() is not None else 0
        else:
            if not existing.active:
                delta = 1
            existing.active = True
            existing.reason = reason or existing.reason
    elif existing is not None and existing.active:
        existing.active = False
        delta = -1
    if delta:
        await db.execute(update(Work).where(Work.id == work.id).values(thanks_count=func.greatest(Work.thanks_count + delta, 0)))
    count = await db.scalar(select(Work.thanks_count).where(Work.id == work.id))
    return {"thanked": on, "reason": reason if on else None, "thanks": count, "charged": False}


async def set_follow(db: AsyncSession, user: User, target_type: str, target_id: int, on: bool, notify_on_complete: bool | None = None) -> dict:
    if target_type not in ("author", "work"):
        raise Invalid()
    if target_type == "author" and await db.get(AuthorProfile, target_id) is None:
        raise NotFound("Muallif topilmadi")
    if target_type == "work" and await db.get(Work, target_id) is None:
        raise NotFound("Asar topilmadi")
    if on:
        stmt = insert(Follow).values(user_id=user.id, target_type=target_type, target_id=target_id, notify_on_complete=bool(notify_on_complete))
        if notify_on_complete is not None:
            stmt = stmt.on_conflict_do_update(index_elements=["user_id", "target_type", "target_id"], set_={"notify_on_complete": notify_on_complete})
        else:
            stmt = stmt.on_conflict_do_nothing()
        await db.execute(stmt)
    else:
        await db.execute(delete(Follow).where(Follow.user_id == user.id, Follow.target_type == target_type, Follow.target_id == target_id))
    return {"following": on}


async def _user_has_read_chapter(db: AsyncSession, user_id: int | None, chapter: Chapter) -> bool:
    if not user_id:
        return False
    if await db.get(ChapterCompletion, (user_id, chapter.id)):
        return True
    p = await db.get(ReadingProgress, (user_id, chapter.work_id))
    return bool(p and p.furthest_sort_key > chapter.sort_key)


async def _check_restricted(db: AsyncSession, user: User) -> None:
    r = await db.scalar(select(UserRestriction).where(UserRestriction.user_id == user.id, UserRestriction.kind == "comment", UserRestriction.until > utcnow()).limit(1))
    if r:
        raise Forbidden(f"Sharh yozish vaqtincha cheklangan: {r.reason}", code="restricted", until=r.until.isoformat())


async def create_comment(
    db: AsyncSession, actor: Actor, ent: Entitlements, work: Work, body: str, *, chapter_id: int | None = None, parent_id: int | None = None, spoiler: bool = False, client_key: str = ""
) -> Comment:
    s = get_settings()
    text = clean_plain(body)
    if not text:
        raise Invalid("Sharh bo'sh", code="empty")
    if len(text) > s.comment_max_chars:
        raise Invalid(f"Sharh {s.comment_max_chars} belgidan oshmasin", code="too_long")
    if work.comments_policy == "closed":
        raise Forbidden("Bu asarda sharhlar yopilgan", code="comments_closed")
    await _check_restricted(db, actor.user)
    if not client_key:
        raise Invalid("client_key kerak", code="client_key_required")
    dup = await db.scalar(select(Comment).where(Comment.user_id == actor.id, Comment.client_key == client_key[:64]))
    if dup:
        return dup  # retry of the same submission
    recent = await db.scalar(select(func.count()).select_from(Comment).where(Comment.user_id == actor.id, Comment.created_at > utcnow() - timedelta(minutes=1)))
    if (recent or 0) >= s.comment_rate_per_minute:
        from app.core.errors import RateLimited

        raise RateLimited("Juda tez yozyapsiz, bir daqiqadan keyin urinib ko'ring")
    chapter = None
    if chapter_id:
        chapter = await db.get(Chapter, chapter_id)
        if chapter is None or chapter.work_id != work.id:
            raise NotFound("Bob topilmadi")
        if not decide_chapter_access(work, chapter, ent).full:
            raise AccessRequired("Bu bob muhokamasi uchun bobga kirish kerak", code="access_required")
    parent = None
    if parent_id:
        parent = await db.get(Comment, parent_id)
        if parent is None or parent.work_id != work.id or parent.status != "published":
            raise NotFound("Sharh topilmadi")
        chapter_id = parent.chapter_id
    status = "published"
    new_account = actor.user.created_at > utcnow() - timedelta(days=1)
    if new_account and _LINK_RE.search(text):
        status = "pending"  # suspicious: new account posting links goes to moderation
    c = Comment(
        user_id=actor.id,
        work_id=work.id,
        chapter_id=chapter_id,
        parent_id=parent_id,
        body=text,
        spoiler=spoiler,
        status=status,
        is_author_reply=await is_work_author(db, actor, work),
        client_key=client_key[:64],
    )
    db.add(c)
    await db.flush()
    if status == "published":
        await db.execute(update(Work).where(Work.id == work.id).values(comments_count=Work.comments_count + 1))
        if parent and parent.user_id != actor.id:
            await emit(db, f"comment.reply:{c.id}", "comment.reply", {"comment_id": c.id, "parent_user_id": parent.user_id, "work_id": work.id})
    return c


async def edit_comment(db: AsyncSession, actor: Actor, comment: Comment, body: str, expected_revision: int | None = None) -> Comment:
    s = get_settings()
    if comment.user_id != actor.id:
        raise Forbidden("Faqat o'z sharhingizni tahrirlaysiz", code="not_owner")
    if utcnow() - comment.created_at > timedelta(minutes=s.comment_edit_window_minutes):
        raise Forbidden(f"Tahrirlash {s.comment_edit_window_minutes} daqiqa ichida mumkin", code="edit_window_passed")
    if expected_revision is not None and expected_revision != comment.revision:
        raise Conflict("Sharh o'zgargan", code="version_conflict")
    text = clean_plain(body)
    if not text or len(text) > s.comment_max_chars:
        raise Invalid("Sharh uzunligi noto'g'ri", code="too_long")
    comment.body = text
    comment.edited_at = utcnow()
    comment.revision += 1
    return comment


async def delete_own_comment(db: AsyncSession, actor: Actor, comment: Comment) -> None:
    if comment.user_id != actor.id:
        # authors cannot silently delete criticism (T-24): they report instead
        raise Forbidden("Boshqa foydalanuvchi sharhini o'chira olmaysiz. Shikoyat yuboring.", code="not_owner")
    if comment.status == "published":
        await db.execute(update(Work).where(Work.id == comment.work_id).values(comments_count=func.greatest(Work.comments_count - 1, 0)))
    comment.status = "deleted"


async def vote_helpful(db: AsyncSession, user: User, comment: Comment, on: bool) -> int:
    if on:
        res = await db.execute(insert(CommentVote).values(comment_id=comment.id, user_id=user.id).on_conflict_do_nothing().returning(CommentVote.user_id))
        if res.scalar() is not None:
            comment.helpful_count += 1
    else:
        res = await db.execute(delete(CommentVote).where(CommentVote.comment_id == comment.id, CommentVote.user_id == user.id).returning(CommentVote.user_id))
        if res.scalar() is not None:
            comment.helpful_count = max(0, comment.helpful_count - 1)
    return comment.helpful_count


async def pin_comment(db: AsyncSession, actor: Actor, comment: Comment, on: bool) -> None:
    work = await db.get(Work, comment.work_id)
    if not (actor.has("comment.moderate") or (work and await is_work_author(db, actor, work))):
        raise Forbidden("Biriktirish vakolati yo'q", code="permission_denied")
    comment.pinned = on


async def list_comments(
    db: AsyncSession, actor: Actor | None, ent: Entitlements, work: Work, *, chapter_id: int | None, sort: str = "new", cursor: int = 0, limit: int = 30
) -> dict:
    chapter = None
    if chapter_id:
        chapter = await db.get(Chapter, chapter_id)
        if chapter is None or chapter.work_id != work.id:
            raise NotFound("Bob topilmadi")
        if not decide_chapter_access(work, chapter, ent).full:
            raise AccessRequired("Bu bob muhokamasi uchun bobga kirish kerak", code="access_required")
    uid = actor.id if actor else None
    q = select(Comment, User.display_name).join(User, User.id == Comment.user_id).where(Comment.work_id == work.id)
    q = q.where(Comment.chapter_id == chapter_id) if chapter_id else q.where(Comment.chapter_id.is_(None))
    # own pending comments are visible to their author
    q = q.where((Comment.status == "published") | ((Comment.status == "pending") & (Comment.user_id == (uid or -1))))
    order = [Comment.pinned.desc()]
    order += [Comment.helpful_count.desc(), Comment.id.desc()] if sort == "helpful" else [Comment.id.desc()]
    rows = (await db.execute(q.order_by(*order).offset(cursor).limit(limit + 1))).all()
    read = await _user_has_read_chapter(db, uid, chapter) if chapter else True
    voted = set()
    if uid and rows:
        voted = set((await db.scalars(select(CommentVote.comment_id).where(CommentVote.user_id == uid, CommentVote.comment_id.in_([r[0].id for r in rows])))).all())
    items = [comment_dto(c, name, uid, read, c.id in voted) for c, name in rows[:limit]]
    return {"items": items, "next_cursor": cursor + limit if len(rows) > limit else None, "chapter_read": read}


def comment_dto(c: Comment, author_name: str, viewer_id: int | None, chapter_read: bool, voted: bool = False, reveal: bool = False) -> dict:
    hide = (c.spoiler or not chapter_read) and not reveal and c.user_id != viewer_id
    return {
        "id": c.id,
        "parent_id": c.parent_id,
        "chapter_id": c.chapter_id,
        "user": {"id": c.user_id, "name": author_name},
        "body": None if hide else c.body,
        "spoiler_hidden": hide,
        "spoiler": c.spoiler,
        "status": c.status,
        "is_author_reply": c.is_author_reply,
        "pinned": c.pinned,
        "helpful": c.helpful_count,
        "voted_helpful": voted,
        "created_at": c.created_at.isoformat(),
        "edited": c.edited_at is not None,
        "mine": c.user_id == viewer_id,
        "editable_until": (c.created_at + timedelta(minutes=get_settings().comment_edit_window_minutes)).isoformat() if c.user_id == viewer_id else None,
    }


async def report(db: AsyncSession, actor: Actor, target_type: str, target_id: int, reason: str, note: str = "") -> Report:
    if target_type not in ("comment", "story", "author", "work") or reason not in REPORT_REASONS:
        raise Invalid("Noto'g'ri shikoyat", code="report_invalid")
    res = await db.execute(
        insert(Report)
        .values(target_type=target_type, target_id=target_id, reporter_id=actor.id, reason=reason, note=clean_plain(note, 1000))
        .on_conflict_do_nothing(index_elements=["reporter_id", "target_type", "target_id"])
        .returning(Report.id)
    )
    rid = res.scalar()
    if rid is None:
        r = await db.scalar(select(Report).where(Report.reporter_id == actor.id, Report.target_type == target_type, Report.target_id == target_id))
        assert r is not None
        return r
    r = await db.get(Report, rid)
    assert r is not None
    return r


async def moderate(db: AsyncSession, actor: Actor, target_type: str, target_id: int, action: str, reason: str) -> ModerationAction:
    """Hide/restore/approve content or restrict a user. Always with a reason and an audit trail."""
    if target_type == "story":
        actor.require("story.moderate")
    else:
        actor.require("comment.moderate")
    if not reason.strip():
        raise Invalid("Sabab kerak", code="reason_required")
    if action not in ("hide", "restore", "approve", "warn", "restrict"):
        raise Invalid("Noto'g'ri amal", code="action_invalid")
    before = None
    if target_type == "comment":
        c = await db.get(Comment, target_id)
        if c is None:
            raise NotFound()
        before = {"status": c.status}
        was_pub = c.status == "published"
        if action == "hide":
            c.status = "hidden"
        elif action in ("restore", "approve"):
            c.status = "published"
        if was_pub and c.status != "published":
            await db.execute(update(Work).where(Work.id == c.work_id).values(comments_count=func.greatest(Work.comments_count - 1, 0)))
        elif not was_pub and c.status == "published":
            await db.execute(update(Work).where(Work.id == c.work_id).values(comments_count=Work.comments_count + 1))
        if action == "restrict":
            db.add(UserRestriction(user_id=c.user_id, kind="comment", until=utcnow() + timedelta(days=3), reason=clean_plain(reason, 500), created_by=actor.id))
    elif target_type == "story":
        from app.models import AuthorStory

        st = await db.get(AuthorStory, target_id)
        if st is None:
            raise NotFound()
        before = {"status": st.status}
        if action == "hide":
            st.status = "rejected"
            st.moderation_note = clean_plain(reason, 500)
        elif action in ("approve", "restore"):
            st.status = "published"
            now = utcnow()
            if st.publish_at is None or st.publish_at < now:
                st.publish_at = now
            st.expires_at = st.publish_at + timedelta(hours=st.duration_hours)
    elif target_type == "user":
        if action != "restrict":
            raise Invalid()
        db.add(UserRestriction(user_id=target_id, kind="comment", until=utcnow() + timedelta(days=3), reason=clean_plain(reason, 500), created_by=actor.id))
    m = ModerationAction(target_type=target_type, target_id=target_id, moderator_id=actor.id, action=action, reason=clean_plain(reason, 1000))
    db.add(m)
    await db.execute(
        update(Report).where(Report.target_type == target_type, Report.target_id == target_id, Report.status == "open").values(status="resolved", reviewed_by=actor.id, resolution=action, reviewed_at=utcnow())
    )
    await db.flush()
    await audit(db, actor, f"moderation.{action}", target_type, target_id, before=before, reason=reason)
    return m


async def moderation_queue(db: AsyncSession, actor: Actor, limit: int = 50) -> dict:
    if not (actor.has("comment.moderate") or actor.has("story.moderate")):
        raise Forbidden()
    reports = (await db.scalars(select(Report).where(Report.status == "open").order_by(Report.id).limit(limit))).all()
    pending = (await db.scalars(select(Comment).where(Comment.status == "pending").order_by(Comment.id).limit(limit))).all()
    from app.models import AuthorStory

    stories = (await db.scalars(select(AuthorStory).where(AuthorStory.status == "pending").order_by(AuthorStory.id).limit(limit))).all() if actor.has("story.moderate") else []
    comment_ids = {r.target_id for r in reports if r.target_type == "comment"} | {c.id for c in pending}
    comments = {c.id: c for c in (await db.scalars(select(Comment).where(Comment.id.in_(comment_ids or {0})))).all()}
    return {
        "reports": [
            {
                "id": r.id,
                "target_type": r.target_type,
                "target_id": r.target_id,
                "reason": r.reason,
                "note": r.note,
                "created_at": r.created_at.isoformat(),
                "preview": (comments[r.target_id].body[:300] if r.target_type == "comment" and r.target_id in comments else ""),
            }
            for r in reports
        ],
        "pending_comments": [{"id": c.id, "work_id": c.work_id, "body": c.body[:500], "created_at": c.created_at.isoformat()} for c in pending],
        "pending_stories": [{"id": s.id, "author_id": s.author_id, "caption": s.caption, "created_at": s.created_at.isoformat()} for s in stories],
    }

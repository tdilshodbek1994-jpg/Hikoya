"""Author storis inside the Mini App (spec 10). Not Telegram Stories."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.text import clean_plain
from app.core.timeutil import utcnow
from app.models import (
    Asset,
    AuthorProfile,
    AuthorStory,
    Chapter,
    Follow,
    StoryAction,
    StoryFrame,
    StoryHighlight,
    StoryHighlightItem,
    StoryView,
    User,
    Work,
)
from app.services.access import Entitlements
from app.services.identity import Actor, audit

FRAME_KINDS = {"text", "image", "video", "quote", "chapter", "poll"}
ACTIONS = {"", "read", "new_chapter", "follow", "vote"}
BACKGROUNDS = {"violet", "night", "sunset", "forest", "gold", "rose"}
MIN_VIEW_MS = 2000  # a frame counts as viewed after ≥2 s visible (spec 10.6)


async def _author_for(db: AsyncSession, actor: Actor, author_id: int | None) -> AuthorProfile:
    if author_id is None:
        author_id = actor.own_author_id
    if author_id is None:
        raise Forbidden("Avval muallif profili kerak", code="not_author")
    if author_id not in actor.author_ids and not actor.has("author.post_as"):
        raise Forbidden("Faqat o'z storisingizni boshqarasiz", code="not_owner")
    a = await db.get(AuthorProfile, author_id)
    if a is None:
        raise NotFound("Muallif topilmadi")
    return a


def _allowed_hours() -> list[int]:
    return sorted(set([24] + list(get_settings().story_allowed_hours)))


async def create_story(db: AsyncSession, actor: Actor, *, author_id: int | None, caption: str = "", frames: list[dict], duration_hours: int = 24, publish_at: datetime | None = None, audience: str = "all", submit: bool = True) -> AuthorStory:
    if not (actor.has("story.create_own") or actor.has("author.post_as")):
        raise Forbidden("Storis joylash vakolati yo'q", code="permission_denied")
    author = await _author_for(db, actor, author_id)
    if duration_hours not in _allowed_hours():
        raise Invalid(f"Muddat {', '.join(map(str, _allowed_hours()))} soatdan biri bo'lsin", code="duration_invalid")
    if audience not in ("all", "followers"):
        raise Invalid()
    if not frames or len(frames) > 10:
        raise Invalid("1 dan 10 tagacha lavha", code="frames_invalid")
    story = AuthorStory(author_id=author.id, caption=clean_plain(caption, 500), duration_hours=duration_hours, audience=audience, status="draft", created_by=actor.id)
    db.add(story)
    await db.flush()
    for i, f in enumerate(frames):
        await _add_frame(db, actor, story, f, i)
    if submit:
        await submit_story(db, actor, story, publish_at)
    await audit(db, actor, "story.create", "story", story.id, on_behalf_of_author_id=author.id if author.user_id != actor.id else None)
    return story


async def _add_frame(db: AsyncSession, actor: Actor, story: AuthorStory, f: dict, i: int) -> StoryFrame:
    kind = f.get("kind", "text")
    if kind not in FRAME_KINDS:
        raise Invalid("Noto'g'ri lavha turi", code="frame_invalid")
    action = f.get("action_type", "")
    if action not in ACTIONS:
        raise Invalid("Noto'g'ri amal", code="frame_invalid")
    media = f.get("media_asset_id")
    if kind in ("image", "video"):
        a = await db.get(Asset, int(media)) if media else None
        if a is None or (a.owner_id not in (actor.id, None) and not actor.has("author.post_as")):
            raise Invalid("Media topilmadi", code="media_invalid")
        if kind == "image" and a.kind != "image" or kind == "video" and a.kind != "video":
            raise Invalid("Media turi mos emas", code="media_invalid")
        if kind == "video" and (a.meta or {}).get("duration", 0) > get_settings().story_video_max_seconds:
            raise Invalid(f"Video {get_settings().story_video_max_seconds} soniyadan oshmasin", code="video_too_long")
    linked_work = f.get("linked_work_id")
    linked_chapter = f.get("linked_chapter_id")
    if linked_chapter:
        ch = await db.get(Chapter, int(linked_chapter))
        if ch is None:
            raise Invalid("Bob topilmadi", code="link_invalid")
        linked_work = ch.work_id
    if linked_work and await db.get(Work, int(linked_work)) is None:
        raise Invalid("Asar topilmadi", code="link_invalid")
    text = clean_plain(f.get("text", ""), 700)
    duration = 6000 + min(len(text), 700) * 40  # long text frames stay longer (readable)
    if kind == "video":
        duration = int(((await db.get(Asset, int(media))).meta or {}).get("duration", 15) * 1000)  # type: ignore[union-attr]
    poll = [clean_plain(str(o), 40) for o in (f.get("poll_options") or [])][:4] if kind == "poll" else []
    if kind == "poll" and len(poll) < 2:
        raise Invalid("So'rovda kamida 2 variant", code="poll_invalid")
    frame = StoryFrame(
        story_id=story.id,
        sort_key=i,
        kind=kind,
        media_asset_id=int(media) if media else None,
        text=text,
        background=f.get("background") if f.get("background") in BACKGROUNDS else "violet",
        subtitles=clean_plain(f.get("subtitles", ""), 2000),
        action_type=action or ("vote" if kind == "poll" else ""),
        linked_work_id=int(linked_work) if linked_work else None,
        linked_chapter_id=int(linked_chapter) if linked_chapter else None,
        audience="premium" if f.get("audience") == "premium" else "all",
        poll_options=poll,
        duration_ms=min(duration, 60000),
    )
    db.add(frame)
    await db.flush()
    return frame


async def submit_story(db: AsyncSession, actor: Actor, story: AuthorStory, publish_at: datetime | None = None) -> AuthorStory:
    """Trusted authors (and staff with story.publish) publish immediately; others go to review."""
    await _author_for(db, actor, story.author_id)
    now = utcnow()
    story.publish_at = publish_at if publish_at and publish_at > now else now
    story.expires_at = story.publish_at + timedelta(hours=story.duration_hours)
    author = await db.get(AuthorProfile, story.author_id)
    trusted = actor.has("story.publish") or (author is not None and author.publish_policy == "trusted")
    story.status = "published" if trusted else "pending"
    return story


async def archive_story(db: AsyncSession, actor: Actor, story: AuthorStory) -> None:
    await _author_for(db, actor, story.author_id)
    story.status = "archived"


def _live_clause(now: datetime):
    # expiry is checked here, so a stopped scheduler can't keep expired stories visible (T-08)
    return and_(AuthorStory.status == "published", AuthorStory.publish_at <= now, AuthorStory.expires_at > now)


async def feed(db: AsyncSession, user: User | None) -> list[dict]:
    """Followed authors first, then editorially featured / new authors. Grouped per author with seen state."""
    now = utcnow()
    rows = (await db.execute(select(AuthorStory, AuthorProfile).join(AuthorProfile, AuthorProfile.id == AuthorStory.author_id).where(_live_clause(now)).order_by(AuthorStory.publish_at.desc()))).all()
    followed: set[int] = set()
    seen_frames: set[int] = set()
    if user:
        followed = set((await db.scalars(select(Follow.target_id).where(Follow.user_id == user.id, Follow.target_type == "author"))).all())
        seen_frames = set((await db.scalars(select(StoryView.frame_id).where(StoryView.user_id == user.id))).all())
    by_author: dict[int, dict] = {}
    story_ids = [s.id for s, _ in rows]
    frames = (await db.execute(select(StoryFrame.story_id, StoryFrame.id).where(StoryFrame.story_id.in_(story_ids or [0])))).all()
    frames_by_story: dict[int, list[int]] = {}
    for sid, fid in frames:
        frames_by_story.setdefault(sid, []).append(fid)
    from app.services.catalog import asset_urls

    avatars = await asset_urls(db, {a.avatar_asset_id for _, a in rows if a.avatar_asset_id})
    for s, a in rows:
        if s.audience == "followers" and a.id not in followed:
            continue
        e = by_author.setdefault(
            a.id,
            {"author": {"id": a.id, "pen_name": a.pen_name, "avatar_url": avatars.get(a.avatar_asset_id or 0), "verified": a.verification_status == "verified"}, "story_ids": [], "unseen": False, "followed": a.id in followed, "featured": a.editorial_featured, "latest": s.publish_at.isoformat()},
        )
        e["story_ids"].append(s.id)
        if any(fid not in seen_frames for fid in frames_by_story.get(s.id, [])):
            e["unseen"] = True
    items = list(by_author.values())
    items.sort(key=lambda e: (not e["followed"], not e["featured"], not e["unseen"], e["latest"]), reverse=False)
    # within same priority newest first
    return items


async def get_story(db: AsyncSession, story_id: int, user: User | None, ent: Entitlements, is_owner: bool = False) -> dict:
    s = await db.get(AuthorStory, story_id)
    now = utcnow()
    if s is None:
        raise NotFound("Storis topilmadi")
    live = s.status == "published" and s.publish_at and s.publish_at <= now and s.expires_at and s.expires_at > now
    if not live and not is_owner:
        raise NotFound("Storis muddati tugagan")
    a = await db.get(AuthorProfile, s.author_id)
    frames = (await db.scalars(select(StoryFrame).where(StoryFrame.story_id == s.id).order_by(StoryFrame.sort_key))).all()
    seen = set()
    if user:
        seen = set((await db.scalars(select(StoryView.frame_id).where(StoryView.user_id == user.id, StoryView.story_id == s.id))).all())
    from app.services.assets import signed_media_url

    out_frames = []
    for f in frames:
        locked = f.audience == "premium" and not ent.premium and not is_owner
        linked = None
        if f.linked_work_id:
            w = await db.get(Work, f.linked_work_id)
            if w and w.editorial_state in ("published", "delisted"):
                linked = {"work_id": w.id, "code": w.short_code, "title": w.title, "chapter_id": f.linked_chapter_id, "access_policy": w.access_policy}
        out_frames.append(
            {
                "id": f.id,
                "kind": f.kind,
                "locked": locked,
                # private media and full text of premium-only frames are never sent to free users (T-09)
                "text": None if locked else f.text,
                "media_url": None if locked or not f.media_asset_id else await signed_media_url(db, f.media_asset_id),
                "background": f.background,
                "subtitles": None if locked else f.subtitles,
                "action_type": f.action_type,
                "linked": linked,
                "poll_options": f.poll_options if not locked else [],
                "duration_ms": f.duration_ms,
                "seen": f.id in seen,
                "audience": f.audience,
            }
        )
    return {
        "id": s.id,
        "author": {"id": a.id, "pen_name": a.pen_name} if a else None,
        "caption": s.caption,
        "publish_at": s.publish_at.isoformat() if s.publish_at else None,
        "expires_at": s.expires_at.isoformat() if s.expires_at else None,
        "status": s.status,
        "frames": out_frames,
    }


async def author_stories(db: AsyncSession, author_id: int) -> list[int]:
    now = utcnow()
    return list((await db.scalars(select(AuthorStory.id).where(AuthorStory.author_id == author_id, _live_clause(now)).order_by(AuthorStory.publish_at))).all())


async def record_view(db: AsyncSession, user: User, frame_id: int, dwell_ms: int, completed: bool) -> bool:
    if dwell_ms < MIN_VIEW_MS:
        return False
    f = await db.get(StoryFrame, frame_id)
    if f is None:
        raise NotFound()
    s = await db.get(AuthorStory, f.story_id)
    if s is None or s.expires_at is None or s.expires_at <= utcnow():
        return False
    await db.execute(
        insert(StoryView)
        .values(frame_id=frame_id, user_id=user.id, story_id=f.story_id, completed=completed)
        .on_conflict_do_update(index_elements=["frame_id", "user_id"], set_={"impressions": StoryView.impressions + 1, "completed": StoryView.completed | completed})
    )
    return True


async def record_action(db: AsyncSession, user: User, frame_id: int, action: str, value: str = "", client_key: str = "") -> None:
    if action not in ("skip", "link_click", "vote", "follow", "start_work"):
        raise Invalid()
    f = await db.get(StoryFrame, frame_id)
    if f is None:
        raise NotFound()
    if action == "vote":
        if value not in f.poll_options:
            raise Invalid("Variant topilmadi")
        client_key = "vote"  # one vote per user per poll frame
    await db.execute(
        insert(StoryAction).values(story_id=f.story_id, frame_id=f.id, user_id=user.id, action=action, value=value[:64], client_key=client_key[:64]).on_conflict_do_nothing()
    )


async def poll_results(db: AsyncSession, frame_id: int) -> dict:
    rows = (await db.execute(select(StoryAction.value, func.count()).where(StoryAction.frame_id == frame_id, StoryAction.action == "vote").group_by(StoryAction.value))).all()
    return {v: n for v, n in rows}


async def analytics(db: AsyncSession, actor: Actor, author_id: int | None) -> list[dict]:
    """Aggregated numbers only; never who watched (spec 10.6)."""
    author = await _author_for(db, actor, author_id)
    stories = (await db.scalars(select(AuthorStory).where(AuthorStory.author_id == author.id).order_by(AuthorStory.id.desc()).limit(50))).all()
    out = []
    for s in stories:
        impressions = await db.scalar(select(func.coalesce(func.sum(StoryView.impressions), 0)).where(StoryView.story_id == s.id))
        unique = await db.scalar(select(func.count(func.distinct(StoryView.user_id))).where(StoryView.story_id == s.id))
        completed = await db.scalar(select(func.count(func.distinct(StoryView.user_id))).where(StoryView.story_id == s.id, StoryView.completed.is_(True)))
        acts = dict((await db.execute(select(StoryAction.action, func.count()).where(StoryAction.story_id == s.id).group_by(StoryAction.action))).all())
        out.append(
            {
                "story_id": s.id,
                "status": s.status,
                "publish_at": s.publish_at.isoformat() if s.publish_at else None,
                "expires_at": s.expires_at.isoformat() if s.expires_at else None,
                "impressions": int(impressions or 0),
                "unique_views": unique or 0,
                "completed_views": completed or 0,
                "skips": acts.get("skip", 0),
                "link_clicks": acts.get("link_click", 0),
                "work_starts": acts.get("start_work", 0),
                "votes": acts.get("vote", 0),
                "small_sample": (unique or 0) < 5,
            }
        )
    return out


async def add_highlight(db: AsyncSession, actor: Actor, author_id: int | None, title: str, frame_ids: list[int]) -> StoryHighlight:
    author = await _author_for(db, actor, author_id)
    frames = (await db.scalars(select(StoryFrame).join(AuthorStory, AuthorStory.id == StoryFrame.story_id).where(StoryFrame.id.in_(frame_ids), AuthorStory.author_id == author.id))).all()
    if len(frames) != len(set(frame_ids)) or not frames:
        raise Invalid("Lavhalar topilmadi", code="frames_invalid")
    h = StoryHighlight(author_id=author.id, title=clean_plain(title, 48) or "Tanlangan")
    db.add(h)
    await db.flush()
    for i, fid in enumerate(frame_ids):
        db.add(StoryHighlightItem(highlight_id=h.id, frame_id=fid, sort_key=i))
    return h


async def highlight_frames(db: AsyncSession, highlight_id: int, ent: Entitlements, is_owner: bool) -> dict:
    """Highlights are permanent; premium-only frames keep their policy (T-10)."""
    h = await db.get(StoryHighlight, highlight_id)
    if h is None:
        raise NotFound()
    rows = (
        await db.execute(
            select(StoryFrame, AuthorStory.status).join(StoryHighlightItem, StoryHighlightItem.frame_id == StoryFrame.id).join(AuthorStory, AuthorStory.id == StoryFrame.story_id)
            .where(StoryHighlightItem.highlight_id == h.id).order_by(StoryHighlightItem.sort_key)
        )
    ).all()
    from app.services.assets import signed_media_url

    frames = []
    for f, status in rows:
        if status in ("rejected",) and not is_owner:
            continue
        locked = f.audience == "premium" and not ent.premium and not is_owner
        frames.append(
            {"id": f.id, "kind": f.kind, "locked": locked, "text": None if locked else f.text, "background": f.background, "media_url": None if locked or not f.media_asset_id else await signed_media_url(db, f.media_asset_id), "duration_ms": f.duration_ms, "action_type": f.action_type, "linked": {"work_id": f.linked_work_id, "chapter_id": f.linked_chapter_id} if f.linked_work_id else None}
        )
    return {"id": h.id, "title": h.title, "author_id": h.author_id, "frames": frames}


async def my_stories(db: AsyncSession, actor: Actor, author_id: int | None) -> list[dict]:
    author = await _author_for(db, actor, author_id)
    rows = (await db.scalars(select(AuthorStory).where(AuthorStory.author_id == author.id).order_by(AuthorStory.id.desc()).limit(100))).all()
    return [{"id": s.id, "caption": s.caption, "status": s.status, "publish_at": s.publish_at.isoformat() if s.publish_at else None, "expires_at": s.expires_at.isoformat() if s.expires_at else None, "moderation_note": s.moderation_note} for s in rows]


__all__ = ["create_story", "submit_story", "feed", "get_story", "record_view", "record_action", "analytics", "add_highlight", "highlight_frames", "or_"]

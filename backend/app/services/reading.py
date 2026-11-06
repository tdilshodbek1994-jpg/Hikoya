"""Reading progress, sessions, events and the qualified-read signal used by TOP (spec 9, 13)."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import content_schema as cs
from app.core.errors import Invalid, NotFound
from app.core.text import minutes_for_words
from app.core.timeutil import local_date, utcnow
from app.models import (
    AuthorProfile,
    Chapter,
    ChapterCompletion,
    ChapterRevision,
    QualifiedRead,
    ReadingEvent,
    ReadingProgress,
    ReadingSession,
    User,
    Work,
    WorkContributor,
)

QR_VERSION = "qr-v1"
MAX_BLOCKS_PER_SECOND = 2.5  # faster than this looks automated
CONFLICT_GRACE = timedelta(seconds=5)


async def is_author_of(db: AsyncSession, user_id: int, work: Work) -> bool:
    prof_ids = (await db.scalars(select(AuthorProfile.id).where(AuthorProfile.user_id == user_id))).all()
    if not prof_ids:
        return False
    if work.primary_author_id in prof_ids:
        return True
    return bool(
        await db.scalar(select(WorkContributor.id).where(WorkContributor.work_id == work.id, WorkContributor.author_id.in_(prof_ids)))
    )


def qualification_threshold_seconds(words: int) -> float:
    est = minutes_for_words(words) * 60
    return max(8.0, min(45.0, est * 0.5))


async def start_session(
    db: AsyncSession, user: User, work: Work, chapter: Chapter, revision_id: int | None, device_id: str, is_preview: bool, total_blocks: int
) -> ReadingSession:
    s = ReadingSession(
        public_id=secrets.token_urlsafe(16),
        user_id=user.id,
        work_id=work.id,
        chapter_id=chapter.id,
        revision_id=revision_id,
        device_id=device_id[:64],
        is_preview=is_preview,
        total_blocks=total_blocks,
    )
    db.add(s)
    await db.flush()
    return s


async def ingest_events(db: AsyncSession, user: User, events: list[dict]) -> dict:
    """Batch of reader events. Duplicates (same event_id) are ignored, so offline queues can resend (T-16)."""
    accepted = 0
    sessions: dict[str, ReadingSession] = {}
    for ev in events[:200]:
        sid = str(ev.get("session_id", ""))
        sess = sessions.get(sid)
        if sess is None:
            sess = await db.scalar(select(ReadingSession).where(ReadingSession.public_id == sid, ReadingSession.user_id == user.id).with_for_update())
            if sess is None:
                continue
            sessions[sid] = sess
        event_id = str(ev.get("event_id", ""))[:64]
        if not event_id:
            continue
        res = await db.execute(
            insert(ReadingEvent)
            .values(
                event_id=event_id,
                session_id=sess.id,
                user_id=user.id,
                sequence=int(ev.get("sequence", 0)),
                event_type=str(ev.get("type", "heartbeat"))[:24],
                position={k: ev[k] for k in ("block_id", "offset", "ratio") if k in ev},
            )
            .on_conflict_do_nothing(index_elements=["event_id"])
            .returning(ReadingEvent.id)
        )
        if res.scalar() is None:
            continue  # duplicate
        accepted += 1
        now = utcnow()
        wall = (now - sess.last_seen_at).total_seconds() if sess.last_seen_at else 0
        delta = max(0.0, min(float(ev.get("active_seconds", 0) or 0), 60.0))
        # active time can never exceed wall-clock time since the session started (+ small grace)
        elapsed_total = (now - sess.started_at).total_seconds() + 5
        sess.active_seconds = min(sess.active_seconds + delta, elapsed_total)
        seen = set(sess.blocks_seen or [])
        for b in ev.get("blocks") or []:
            if isinstance(b, str) and cs.BID_RE.match(b):
                seen.add(b)
        sess.blocks_seen = list(seen)[:5000]
        sess.last_seen_at = now
        if wall < 0:
            sess.flagged = "clock"
    qualified = []
    for sess in sessions.values():
        if await evaluate_qualification(db, sess):
            qualified.append(sess.public_id)
    return {"accepted": accepted, "qualified_sessions": qualified}


async def evaluate_qualification(db: AsyncSession, sess: ReadingSession) -> bool:
    """Qualified read (spec 13.3): ≥20% blocks seen, active time threshold, not preview/author/test, sane speed."""
    if sess.qualified or sess.is_preview or not sess.total_blocks:
        return False
    user = await db.get(User, sess.user_id)
    work = await db.get(Work, sess.work_id)
    chapter = await db.get(Chapter, sess.chapter_id)
    if user is None or work is None or chapter is None or user.is_test:
        return False
    if await is_author_of(db, user.id, work):
        return False
    seen = len(sess.blocks_seen or [])
    if seen < 0.2 * sess.total_blocks:
        return False
    if sess.active_seconds < qualification_threshold_seconds(chapter.words):
        return False
    if sess.active_seconds > 0 and seen / sess.active_seconds > MAX_BLOCKS_PER_SECOND:
        sess.flagged = "too_fast"
        return False
    sess.qualified = True
    await db.execute(
        insert(QualifiedRead)
        .values(user_id=user.id, work_id=work.id, local_date=local_date(), reason_version=QR_VERSION)
        .on_conflict_do_nothing(index_elements=["user_id", "work_id", "local_date"])
    )
    return True


async def put_progress(db: AsyncSession, user: User, p: dict) -> dict:
    """Save the reader's current position.

    * ``current_*`` = last conscious position (going back to chapter 2 after 7 moves current back).
    * ``furthest_*`` never decreases (T-13).
    * an older event from the same device (lower sequence) is ignored (T-14).
    * a stale position from another device does not silently overwrite a newer one (T-15).
    """
    work = await db.get(Work, int(p["work_id"]))
    chapter = await db.get(Chapter, int(p["chapter_id"]))
    if work is None or chapter is None or chapter.work_id != work.id:
        raise NotFound("Bob topilmadi")
    device = str(p.get("device_id", ""))[:64]
    seq = int(p.get("sequence", 0))
    ratio = max(0.0, min(float(p.get("ratio", 0) or 0), 1.0))
    client_ts = p.get("client_ts")
    if isinstance(client_ts, str):
        client_ts = datetime.fromisoformat(client_ts.replace("Z", "+00:00"))
    now = utcnow()
    if client_ts is None or client_ts > now + timedelta(minutes=2):
        client_ts = now
    force = bool(p.get("force"))

    prog = await db.scalar(
        select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.work_id == work.id).with_for_update()
    )
    if prog is None:
        await db.execute(
            insert(ReadingProgress)
            .values(user_id=user.id, work_id=work.id, chapter_id=chapter.id, device_id=device, last_sequence=0, updated_at=client_ts)
            .on_conflict_do_nothing(index_elements=["user_id", "work_id"])
        )
        prog = await db.scalar(
            select(ReadingProgress).where(ReadingProgress.user_id == user.id, ReadingProgress.work_id == work.id).with_for_update()
        )
        assert prog is not None
        fresh = True
    else:
        fresh = False

    if not fresh and not force:
        if prog.device_id == device and seq <= prog.last_sequence:
            return {"status": "stale_ignored", "progress": progress_dto(prog)}
        if prog.device_id != device and client_ts < prog.updated_at - CONFLICT_GRACE:
            other_ch = await db.get(Chapter, prog.chapter_id)
            return {
                "status": "conflict",
                "progress": progress_dto(prog),
                "other": {"chapter_id": prog.chapter_id, "chapter_title": other_ch.title if other_ch else "", "ratio": prog.current_ratio},
            }

    prog.chapter_id = chapter.id
    prog.chapter_revision_id = p.get("revision_id") or chapter.published_revision_id
    block_id = str(p.get("block_id", ""))[:32]
    prog.current_block_id = block_id if (not block_id or cs.BID_RE.match(block_id)) else ""
    prog.current_offset = float(p.get("offset", 0) or 0)
    prog.current_ratio = ratio
    prog.device_id = device
    prog.last_sequence = seq
    prog.updated_at = max(client_ts, prog.updated_at) if not force else now
    if chapter.sort_key > prog.furthest_sort_key or (chapter.sort_key == prog.furthest_sort_key and ratio > prog.furthest_ratio):
        if chapter.sort_key > prog.furthest_sort_key:
            prog.furthest_ratio = ratio
        else:
            prog.furthest_ratio = max(prog.furthest_ratio, ratio)
        prog.furthest_sort_key = chapter.sort_key
        prog.furthest_chapter_id = chapter.id
    completed_now = False
    if ratio >= 0.97:
        res = await db.execute(
            insert(ChapterCompletion)
            .values(user_id=user.id, chapter_id=chapter.id, work_id=work.id)
            .on_conflict_do_nothing(index_elements=["user_id", "chapter_id"])
            .returning(ChapterCompletion.chapter_id)
        )
        completed_now = res.scalar() is not None
        last = await db.scalar(
            select(Chapter.id)
            .where(Chapter.work_id == work.id, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None))
            .order_by(Chapter.sort_key.desc())
            .limit(1)
        )
        if last == chapter.id and work.completion_state == "completed":
            prog.completion_state = "completed"
    return {"status": "saved", "progress": progress_dto(prog), "chapter_completed": completed_now}


def progress_dto(p: ReadingProgress) -> dict:
    return {
        "work_id": p.work_id,
        "chapter_id": p.chapter_id,
        "revision_id": p.chapter_revision_id,
        "block_id": p.current_block_id,
        "offset": p.current_offset,
        "ratio": p.current_ratio,
        "furthest_chapter_id": p.furthest_chapter_id,
        "furthest_ratio": p.furthest_ratio,
        "completion_state": p.completion_state,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        "device_id": p.device_id,
        "sequence": p.last_sequence,
    }


async def resolve_position(db: AsyncSession, saved_revision_id: int | None, block_id: str, current_revision: ChapterRevision) -> dict:
    """Map a saved position onto the currently published revision (T-17)."""
    if not block_id:
        return {"block_id": "", "text_updated": False}
    if saved_revision_id == current_revision.id or block_id in (current_revision.block_ids or []):
        return {"block_id": block_id, "text_updated": saved_revision_id not in (None, current_revision.id)}
    old = await db.get(ChapterRevision, saved_revision_id) if saved_revision_id else None
    new_bid, moved = cs.nearest_preserved_block(old.block_ids if old else [], current_revision.block_ids or [], block_id)
    return {"block_id": new_bid, "text_updated": True, "moved": moved}


async def get_progress(db: AsyncSession, user_id: int, work_id: int) -> ReadingProgress | None:
    return await db.scalar(select(ReadingProgress).where(ReadingProgress.user_id == user_id, ReadingProgress.work_id == work_id))


def validate_device(device_id: str) -> str:
    if not device_id or len(device_id) > 64:
        raise Invalid("device_id kerak", code="device_required")
    return device_id


__all__ = [
    "start_session",
    "ingest_events",
    "put_progress",
    "resolve_position",
    "get_progress",
    "progress_dto",
    "evaluate_qualification",
]

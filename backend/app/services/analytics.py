"""Owner analytics: daily series, funnel, retention and chapter drop-off (Asia/Tashkent days).

Only aggregates leave this module (no user lists). Test accounts and demo works are excluded.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import and_, distinct, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.timeutil import utcnow
from app.models import Chapter, ChapterCompletion, Payment, QualifiedRead, ReadingSession, User, Work
from app.services.identity import Actor


def _day(col):
    return func.date(func.timezone(get_settings().timezone, col))


async def analytics(db: AsyncSession, actor: Actor, days: int = 30) -> dict:
    actor.require("stats.view_all")
    days = max(7, min(days, 90))
    now = utcnow()
    since = now - timedelta(days=days)
    real_user = and_(User.is_test.is_(False))
    real_work = Work.is_demo.is_(False)

    async def series(q) -> dict[str, int]:
        return {d.isoformat(): int(n) for d, n in (await db.execute(q)).all()}

    new_users = await series(select(_day(User.created_at), func.count()).where(User.created_at >= since, real_user).group_by(text("1")))
    active = await series(
        select(_day(ReadingSession.started_at), func.count(distinct(ReadingSession.user_id)))
        .join(User, User.id == ReadingSession.user_id).join(Work, Work.id == ReadingSession.work_id)
        .where(ReadingSession.started_at >= since, real_user, real_work).group_by(text("1"))
    )
    readers = await series(
        select(QualifiedRead.local_date, func.count(distinct(QualifiedRead.user_id)))
        .join(User, User.id == QualifiedRead.user_id).join(Work, Work.id == QualifiedRead.work_id)
        .where(QualifiedRead.qualified_at >= since, real_user, real_work).group_by(text("1"))
    )
    stars: dict[str, int] = {}
    if actor.has("billing.view"):
        stars = await series(
            select(_day(Payment.confirmed_at), func.coalesce(func.sum(Payment.amount), 0))
            .where(Payment.confirmed_at >= since, Payment.state == "confirmed").group_by(text("1"))
        )
    today = (now + timedelta(hours=5)).date()  # Tashkent is UTC+5 all year
    labels = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    daily = [{"date": d, "new_users": new_users.get(d, 0), "active_readers": active.get(d, 0), "qualified_readers": readers.get(d, 0), **({"stars": stars.get(d, 0)} if actor.has("billing.view") else {})} for d in labels]

    # funnel for users who joined in the period
    cohort = select(User.id).where(User.created_at >= since, real_user).subquery()
    joined = await db.scalar(select(func.count()).select_from(cohort)) or 0
    started = await db.scalar(select(func.count(distinct(ReadingSession.user_id))).where(ReadingSession.user_id.in_(select(cohort.c.id)))) or 0
    qualified = await db.scalar(select(func.count(distinct(QualifiedRead.user_id))).where(QualifiedRead.user_id.in_(select(cohort.c.id)))) or 0
    paid = await db.scalar(select(func.count(distinct(Payment.user_id))).where(Payment.user_id.in_(select(cohort.c.id)), Payment.state == "confirmed")) if actor.has("billing.view") else None
    funnel = [
        {"step": "joined", "users": joined},
        {"step": "started_reading", "users": started},
        {"step": "qualified_read", "users": qualified},
    ] + ([{"step": "paid", "users": paid or 0}] if paid is not None else [])

    # retention: share of the cohort that read again on day 1 / in days 7–13 after joining
    join_day = _day(User.created_at)
    sess_day = _day(ReadingSession.started_at)
    async def returned(lo: int, hi: int) -> int:
        q = (
            select(func.count(distinct(User.id)))
            .join(ReadingSession, ReadingSession.user_id == User.id)
            .where(User.created_at >= since, real_user, sess_day >= join_day + lo, sess_day <= join_day + hi)
        )
        return await db.scalar(q) or 0

    # only users old enough to have had the chance
    def eligible(min_age: int):
        return select(func.count()).select_from(User).where(User.created_at >= since, User.created_at <= now - timedelta(days=min_age), real_user)

    e1, e7 = (await db.scalar(eligible(1)) or 0), (await db.scalar(eligible(7)) or 0)
    r1, r7 = await returned(1, 1), await returned(7, 13)
    retention = {
        "d1": {"eligible": e1, "returned": min(r1, e1), "percent": round(100 * min(r1, e1) / e1) if e1 else None},
        "d7": {"eligible": e7, "returned": min(r7, e7), "percent": round(100 * min(r7, e7) / e7) if e7 else None},
        "small_sample": e1 < 30,
    }

    # chapter drop-off for the 5 most read works of the period
    top = (
        await db.execute(
            select(Work.id, Work.title, func.count(distinct(ReadingSession.user_id)).label("n"))
            .join(ReadingSession, ReadingSession.work_id == Work.id)
            .join(User, User.id == ReadingSession.user_id)
            .where(ReadingSession.started_at >= since, real_work, real_user)
            .group_by(Work.id, Work.title).order_by(func.count(distinct(ReadingSession.user_id)).desc()).limit(5)
        )
    ).all()
    dropoff = []
    for wid, title, _n in top:
        chs = (await db.execute(select(Chapter.id, Chapter.title).where(Chapter.work_id == wid, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None)).order_by(Chapter.sort_key))).all()
        opened = dict((await db.execute(select(ReadingSession.chapter_id, func.count(distinct(ReadingSession.user_id))).where(ReadingSession.work_id == wid, ReadingSession.started_at >= since, ReadingSession.is_preview.is_(False)).group_by(text("1")))).all())
        done = dict((await db.execute(select(ChapterCompletion.chapter_id, func.count(distinct(ChapterCompletion.user_id))).where(ChapterCompletion.chapter_id.in_([c[0] for c in chs] or [0]), ChapterCompletion.completed_at >= since).group_by(text("1")))).all())
        dropoff.append({"work_id": wid, "title": title, "chapters": [{"id": cid, "title": ct, "opened": int(opened.get(cid, 0)), "completed": int(done.get(cid, 0))} for cid, ct in chs[:60]]})

    return {
        "days": days,
        "computed_at": now.isoformat(),
        "daily": daily,
        "totals": {
            "new_users": sum(x["new_users"] for x in daily),
            "stars": sum(x.get("stars", 0) for x in daily) if actor.has("billing.view") else None,
        },
        "funnel": funnel,
        "retention": retention,
        "dropoff": dropoff,
        "note": "Test akkauntlar va demo asarlar hisobga olinmagan. Kunlar Toshkent vaqti bo'yicha.",
    }


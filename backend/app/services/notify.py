"""In-app notifications, outbox fan-out and Telegram delivery (spec 12, 30).

* each event creates an in-app notification once (unique dedupe_key);
* Telegram delivery is optional (user consent), respects quiet hours and digest mode;
* 429 → retry_after backoff; blocked bot → stop sending to that user (T-57);
* "exactly once" external delivery is not promised; ambiguous sends are marked ``uncertain``.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.timeutil import in_quiet_hours, next_quiet_end, utcnow
from app.integrations.telegram import TelegramError, TelegramUncertain, get_telegram
from app.models import (
    AuthorProfile,
    Chapter,
    Comment,
    Delivery,
    EditorialReview,
    Follow,
    Notification,
    NotificationPreference,
    OutboxEvent,
    Payment,
    ReadingProgress,
    RoleGrant,
    Subscription,
    User,
    Work,
)

MAX_ATTEMPTS = 6


async def notify(db: AsyncSession, user_id: int, type_: str, dedupe_key: str, title: str, body: str = "", link: str = "", payload: dict | None = None, service: bool = False) -> int | None:
    res = await db.execute(
        insert(Notification)
        .values(user_id=user_id, type=type_, dedupe_key=dedupe_key[:160], title=title[:200], body=body[:1000], link=link[:64], payload=payload or {})
        .on_conflict_do_nothing(index_elements=["dedupe_key"])
        .returning(Notification.id)
    )
    nid = res.scalar()
    if nid is None:
        return None
    user = await db.get(User, user_id)
    prefs = await db.get(NotificationPreference, user_id)
    wants = user is not None and user.bot_started and not user.bot_blocked and (user.bot_messages_allowed or service)
    if wants and prefs and type_ in (prefs.disabled_types or []) and not service:
        wants = False
    if wants:
        db.add(Delivery(notification_id=nid, user_id=user_id, is_service=service, status="pending"))
    return nid


def _link_url(link: str) -> str:
    s = get_settings()
    return f"https://t.me/{s.bot_username}/{s.miniapp_short_name}?startapp={link}" if link else f"https://t.me/{s.bot_username}/{s.miniapp_short_name}"


async def process_outbox(db: AsyncSession, limit: int = 100) -> int:
    rows = (await db.scalars(select(OutboxEvent).where(OutboxEvent.processed_at.is_(None)).order_by(OutboxEvent.id).limit(limit).with_for_update(skip_locked=True))).all()
    for ev in rows:
        try:
            await _handle_event(db, ev)
            ev.processed_at = utcnow()
        except Exception as e:  # keep the event for retry, do not block others
            ev.attempts += 1
            ev.last_error = str(e)[:500]
            if ev.attempts >= MAX_ATTEMPTS:
                ev.processed_at = utcnow()
    return len(rows)


async def _handle_event(db: AsyncSession, ev: OutboxEvent) -> None:
    p = ev.payload
    if ev.type == "chapter.published":
        if not p.get("first_time"):
            return  # text corrections do not notify
        work = await db.get(Work, p["work_id"])
        chapter = await db.get(Chapter, p["chapter_id"])
        if work is None or chapter is None or work.visibility != "public":
            return
        n_published = work.chapters_published
        targets: set[int] = set()
        targets |= set((await db.scalars(select(Follow.user_id).where(Follow.target_type == "work", Follow.target_id == work.id))).all())
        targets |= set((await db.scalars(select(ReadingProgress.user_id).where(ReadingProgress.work_id == work.id))).all())
        author_followers = set((await db.scalars(select(Follow.user_id).where(Follow.target_type == "author", Follow.target_id == work.primary_author_id))).all())
        author = await db.get(AuthorProfile, work.primary_author_id)
        # chapter titles only — never chapter text or spoilers in a push
        for uid in targets:
            await notify(db, uid, "new_chapter", f"new_chapter:{chapter.id}:{uid}", f"«{work.title}»: yangi bob", chapter.title, f"c_{chapter.id}", {"work_id": work.id, "chapter_id": chapter.id})
        if n_published == 1:
            for uid in author_followers - targets:
                await notify(db, uid, "new_work", f"new_work:{work.id}:{uid}", f"{author.pen_name if author else 'Muallif'}: yangi asar", work.title, f"w_{work.short_code}", {"work_id": work.id})
    elif ev.type == "work.completed":
        work = await db.get(Work, p["work_id"])
        if work is None:
            return
        for uid in (await db.scalars(select(Follow.user_id).where(Follow.target_type == "work", Follow.target_id == work.id, Follow.notify_on_complete.is_(True)))).all():
            await notify(db, uid, "work_completed", f"work_completed:{work.id}:{uid}", f"«{work.title}» tugallandi", "Endi boshidan oxirigacha o'qish mumkin", f"w_{work.short_code}")
    elif ev.type == "comment.reply":
        c = await db.get(Comment, p["comment_id"])
        work = await db.get(Work, p["work_id"])
        if c is None or work is None:
            return
        # reply text is not included (it may contain spoilers)
        await notify(db, p["parent_user_id"], "comment_reply", f"comment_reply:{c.id}", "Sharhingizga javob berishdi", f"«{work.title}»", f"w_{work.short_code}", {"comment_id": c.id})
    elif ev.type == "review.decided":
        r = await db.get(EditorialReview, p["review_id"])
        work = await db.get(Work, p["work_id"])
        if r is None or work is None or r.submitted_by is None:
            return
        if p["decision"] == "changes_requested":
            await notify(db, r.submitted_by, "edit_request", f"edit_request:{r.id}", f"«{work.title}»: tuzatish so'raldi", r.note[:300], f"s_{work.id}")
        else:
            await notify(db, r.submitted_by, "system", f"review_ok:{r.id}", f"«{work.title}» tasdiqlandi", "", f"s_{work.id}")
    elif ev.type == "review.submitted":
        work = await db.get(Work, p["work_id"])
        reviewers = set((await db.scalars(select(RoleGrant.user_id).where(RoleGrant.revoked_at.is_(None), RoleGrant.role.in_(("content_admin", "owner")), RoleGrant.scope_type == "global"))).all())
        reviewers |= set((await db.scalars(select(RoleGrant.user_id).where(RoleGrant.revoked_at.is_(None), RoleGrant.role == "editor", RoleGrant.scope_type == "work", RoleGrant.scope_id == p["work_id"]))).all())
        for uid in reviewers:
            await notify(db, uid, "system", f"review_q:{ev.event_key}:{uid}", "Tekshiruv navbatida yangi ish", work.title if work else "", "q_review")
    elif ev.type == "publish.failed":
        work = await db.get(Work, p["work_id"])
        if work and work.created_by_user_id:
            await notify(db, work.created_by_user_id, "system", f"publish_failed:{p['job_id']}", "Rejalashtirilgan nashr bajarilmadi", "; ".join(x["message"] for x in p.get("problems", []))[:500], f"s_{work.id}")
    elif ev.type == "billing.paid":
        pay = await db.get(Payment, p["payment_id"])
        if pay:
            title = "Premium yangilandi" if p.get("renewal") else "To'lov tasdiqlandi"
            await notify(db, p["user_id"], "billing", f"billing.paid:{pay.id}", title, f"{pay.amount} ⭐", "premium", service=True)
    elif ev.type == "billing.gift":
        giver = await db.get(User, p["from_user_id"])
        name = giver.display_name if giver and giver.display_name else "Do'stingiz"
        link = "premium"
        if p.get("access_scope") == "work" and p.get("scope_id"):
            w = await db.get(Work, int(p["scope_id"]))
            link = f"w_{w.short_code}" if w else "library"
        await notify(db, p["to_user_id"], "billing", f"billing.gift:{p['payment_id']}", "🎁 Sizga sovg'a!", f"{name} sizga «{p.get('title', '')}» sovg'a qildi", link, service=True)
    elif ev.type == "referral.rewarded":
        await notify(db, p["user_id"], "billing", f"referral:{ev.event_key}", "🎉 Do'stingiz o'qishni boshladi", f"Sizga {p['days']} kun Premium qo'shildi. Rahmat!", "premium", service=True)
    elif ev.type == "billing.refunded":
        await notify(db, p["user_id"], "billing", f"billing.refunded:{p['payment_id']}", "To'lov qaytarildi", "", "premium", service=True)
    elif ev.type == "billing.subscription":
        sub = await db.get(Subscription, p["subscription_id"])
        if sub and p["state"] in ("canceled", "failed"):
            body = "Yangilanish o'chirildi" if p["state"] == "canceled" else "Yangilash to'lovi o'tmadi"
            until = f", {sub.paid_until:%d.%m.%Y} gacha faol" if sub.paid_until else ""
            await notify(db, p["user_id"], "billing", f"billing.sub:{ev.event_key}", "Obuna holati o'zgardi", body + until, "premium", service=True)


async def deliver_pending(db: AsyncSession, limit: int = 50) -> dict:
    """Send due deliveries. Digest users and several pending items are grouped into one message (T-56)."""
    now = utcnow()
    rows = (
        await db.scalars(
            select(Delivery).where(Delivery.status == "pending", Delivery.next_attempt_at <= now).order_by(Delivery.user_id, Delivery.id).limit(limit).with_for_update(skip_locked=True)
        )
    ).all()
    by_user: dict[int, list[Delivery]] = {}
    for d in rows:
        by_user.setdefault(d.user_id, []).append(d)
    stats = {"sent": 0, "deferred": 0, "failed": 0, "skipped": 0}
    tg = get_telegram()
    for uid, items in by_user.items():
        user = await db.get(User, uid)
        prefs = await db.get(NotificationPreference, uid)
        if user is None or user.bot_blocked:
            for d in items:
                d.status = "skipped"
            stats["skipped"] += len(items)
            continue
        service = [d for d in items if d.is_service]
        regular = [d for d in items if not d.is_service]
        tz_name = prefs.timezone if prefs else get_settings().timezone
        if regular and prefs and in_quiet_hours(prefs.quiet_start, prefs.quiet_end, tz_name, now):
            nxt = next_quiet_end(prefs.quiet_end, tz_name, now)
            for d in regular:
                d.next_attempt_at = nxt
            stats["deferred"] += len(regular)
            regular = []
        if regular and prefs and prefs.mode == "digest":
            # digest: send once a day at the end of quiet hours (or 19:00 when there are none)
            last = await db.scalar(select(Delivery.sent_at).where(Delivery.user_id == uid, Delivery.status == "sent", Delivery.is_service.is_(False)).order_by(Delivery.sent_at.desc()).limit(1))
            if last and now - last < timedelta(hours=20):
                for d in regular:
                    d.next_attempt_at = last + timedelta(hours=20)
                stats["deferred"] += len(regular)
                regular = []
        for group in ([service] if service else []) + ([regular] if regular else []):
            notes = [await db.get(Notification, d.notification_id) for d in group]
            notes = [n for n in notes if n is not None]
            if not notes:
                continue
            if len(notes) == 1:
                n = notes[0]
                text = f"<b>{_esc(n.title)}</b>\n{_esc(n.body)}".strip()
                link = n.link
            else:
                lines = [f"• {_esc(n.title)}" + (f" — {_esc(n.body)}" if n.body else "") for n in notes[:15]]
                text = "<b>Yangiliklar</b>\n" + "\n".join(lines)
                link = "notifications"
            try:
                await tg.call("sendMessage", chat_id=user.telegram_user_id, text=text, parse_mode="HTML", reply_markup={"inline_keyboard": [[{"text": "Ochish", "url": _link_url(link)}]]})
                for d in group:
                    d.status, d.sent_at, d.attempts = "sent", now, d.attempts + 1
                stats["sent"] += len(group)
            except TelegramError as e:
                if e.blocked:
                    user.bot_blocked = True
                    for d in group:
                        d.status, d.last_error = "failed", "blocked"
                    stats["failed"] += len(group)
                elif e.code == 429:
                    wait = e.retry_after or 30
                    for d in group:
                        d.attempts += 1
                        d.next_attempt_at = now + timedelta(seconds=wait)
                        d.last_error = "429"
                    stats["deferred"] += len(group)
                else:
                    for d in group:
                        d.attempts += 1
                        d.last_error = e.description[:300]
                        d.status = "failed" if d.attempts >= MAX_ATTEMPTS else "pending"
                        d.next_attempt_at = now + timedelta(seconds=30 * 2 ** d.attempts)
                    stats["failed"] += len(group)
            except TelegramUncertain as e:
                # may have been delivered: do not resend blindly
                for d in group:
                    d.status, d.last_error = "uncertain", str(e)[:300]
    return stats


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def list_notifications(db: AsyncSession, user_id: int, limit: int = 50, before: int | None = None) -> list[dict]:
    q = select(Notification).where(Notification.user_id == user_id)
    if before:
        q = q.where(Notification.id < before)
    rows = (await db.scalars(q.order_by(Notification.id.desc()).limit(limit))).all()
    return [{"id": n.id, "type": n.type, "title": n.title, "body": n.body, "link": n.link, "created_at": n.created_at.isoformat(), "read": n.read_at is not None} for n in rows]


async def mark_read(db: AsyncSession, user_id: int, ids: list[int] | None) -> None:
    q = update(Notification).where(Notification.user_id == user_id, Notification.read_at.is_(None))
    if ids:
        q = q.where(Notification.id.in_(ids))
    await db.execute(q.values(read_at=utcnow()))

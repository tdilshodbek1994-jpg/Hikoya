"""Growth tools: promo codes and invite-a-friend rewards.

Both give Premium *days* as ordinary entitlement grants (source "promo" / "referral"), stacked
after the current paid period like one-time packages. They never touch Stars payments.

Referral anti-abuse:
* only accounts created through the invite link (first login) are bound; nobody can be re-bound;
* the reward is paid only after the invited user's first qualified read (a real reading session),
  not for opening the app;
* per-inviter monthly cap (``referral_max_rewards_per_month``).
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import Conflict, Invalid, NotFound
from app.core.timeutil import utcnow
from app.models import EntitlementGrant, PromoCode, PromoRedemption, QualifiedRead, Referral, User
from app.services.access import load_entitlements
from app.services.events import emit
from app.services.identity import Actor, audit

CODE_RE = re.compile(r"^[A-Z0-9_-]{4,32}$")
NEW_USER_WINDOW = timedelta(minutes=30)


async def _grant_days(db: AsyncSession, user_id: int, source: str, source_id: str, days: int, terms: dict) -> datetime:
    now = utcnow()
    ent = await load_entitlements(db, user_id, now)
    start = max(now, ent.premium_until) if ent.premium_until else now
    end = start + timedelta(days=days)
    await db.execute(
        insert(EntitlementGrant)
        .values(user_id=user_id, source_type=source, source_id=source_id, scope_type="premium", scope_id=0, starts_at=start, expires_at=end, terms=terms)
        .on_conflict_do_nothing(index_elements=["source_type", "source_id", "scope_type", "scope_id"])
    )
    return end


# ------------------------------------------------------------------ promo codes


def normalize_code(code: str) -> str:
    return (code or "").strip().upper().replace(" ", "")


async def create_promo(db: AsyncSession, actor: Actor, *, code: str | None, days: int, max_uses: int | None, valid_until: datetime | None, new_users_only: bool, note: str) -> PromoCode:
    actor.require("billing.manage_products")
    code = normalize_code(code or "") or secrets.token_hex(4).upper()
    if not CODE_RE.match(code):
        raise Invalid("Kod 4–32 belgi: lotin harflari, raqam, - yoki _", code="code_invalid")
    if not 1 <= days <= 366:
        raise Invalid("Kunlar 1–366", code="days_invalid")
    if max_uses is not None and max_uses < 1:
        raise Invalid("Foydalanish soni musbat bo'lsin", code="max_uses_invalid")
    if await db.scalar(select(PromoCode.id).where(PromoCode.code == code)):
        raise Conflict("Bunday kod bor", code="code_exists")
    p = PromoCode(code=code, days=days, max_uses=max_uses, valid_until=valid_until, new_users_only=new_users_only, note=note[:500], created_by=actor.id)
    db.add(p)
    await db.flush()
    await audit(db, actor, "promo.create", "promo", p.id, after={"code": code, "days": days, "max_uses": max_uses})
    return p


def promo_dto(p: PromoCode) -> dict:
    return {
        "id": p.id, "code": p.code, "days": p.days, "max_uses": p.max_uses, "uses": p.uses,
        "valid_until": p.valid_until.isoformat() if p.valid_until else None, "new_users_only": p.new_users_only,
        "active": p.active, "note": p.note, "created_at": p.created_at.isoformat(),
    }


async def redeem_promo(db: AsyncSession, user: User, code: str) -> dict:
    code = normalize_code(code)
    p = await db.scalar(select(PromoCode).where(PromoCode.code == code).with_for_update()) if CODE_RE.match(code or "") else None
    now = utcnow()
    # one message for unknown / inactive / expired: codes cannot be probed
    if p is None or not p.active or (p.valid_until and p.valid_until < now):
        raise NotFound("Kod topilmadi yoki muddati tugagan", code="promo_not_found")
    if p.max_uses is not None and p.uses >= p.max_uses:
        raise Conflict("Bu kodning limiti tugagan", code="promo_exhausted")
    if p.new_users_only and user.created_at < now - timedelta(days=3):
        raise Conflict("Bu kod faqat yangi foydalanuvchilar uchun", code="promo_new_users_only")
    res = await db.execute(insert(PromoRedemption).values(promo_id=p.id, user_id=user.id).on_conflict_do_nothing().returning(PromoRedemption.user_id))
    if res.scalar() is None:
        raise Conflict("Siz bu kodni allaqachon ishlatgansiz", code="promo_already_used")
    p.uses += 1
    until = await _grant_days(db, user.id, "promo", f"{p.id}:{user.id}", p.days, {"code": p.code, "days": p.days})
    return {"days": p.days, "premium_until": until.isoformat()}


# ------------------------------------------------------------------ referrals


def referral_param(user: User) -> str:
    return f"r_{user.id}"


async def bind_referral(db: AsyncSession, user: User, start_param: str) -> bool:
    """Called at login. Binds only a brand-new account to the inviter from ``r_<id>``."""
    if not start_param.startswith("r_") or not start_param[2:].isdigit():
        return False
    referrer_id = int(start_param[2:])
    if referrer_id == user.id or user.created_at < utcnow() - NEW_USER_WINDOW:
        return False
    referrer = await db.get(User, referrer_id)
    if referrer is None or referrer.status != "active":
        return False
    res = await db.execute(insert(Referral).values(referred_user_id=user.id, referrer_user_id=referrer_id).on_conflict_do_nothing().returning(Referral.referred_user_id))
    return res.scalar() is not None


async def reward_referrals(db: AsyncSession, limit: int = 200) -> int:
    """Worker step: pay inviters whose friends have made a first qualified read."""
    s = get_settings()
    if s.referral_bonus_days <= 0:
        return 0
    rows = (
        await db.scalars(
            select(Referral)
            .where(Referral.rewarded_at.is_(None), Referral.reward_skipped == "", select(QualifiedRead.id).where(QualifiedRead.user_id == Referral.referred_user_id).exists())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    ).all()
    paid = 0
    for r in rows:
        month_ago = utcnow() - timedelta(days=30)
        n = await db.scalar(select(func.count()).select_from(Referral).where(Referral.referrer_user_id == r.referrer_user_id, Referral.rewarded_at > month_ago))
        if (n or 0) >= s.referral_max_rewards_per_month:
            r.reward_skipped = "monthly_limit"
            continue
        await _grant_days(db, r.referrer_user_id, "referral", str(r.referred_user_id), s.referral_bonus_days, {"referred_user_id": r.referred_user_id, "days": s.referral_bonus_days})
        r.rewarded_at = utcnow()
        await emit(db, f"referral.rewarded:{r.referred_user_id}", "referral.rewarded", {"user_id": r.referrer_user_id, "days": s.referral_bonus_days})
        paid += 1
    return paid


async def referral_summary(db: AsyncSession, user: User) -> dict:
    s = get_settings()
    total = await db.scalar(select(func.count()).select_from(Referral).where(Referral.referrer_user_id == user.id)) or 0
    rewarded = await db.scalar(select(func.count()).select_from(Referral).where(Referral.referrer_user_id == user.id, Referral.rewarded_at.is_not(None))) or 0
    return {
        "enabled": s.referral_bonus_days > 0,
        "bonus_days": s.referral_bonus_days,
        "link": f"https://t.me/{s.bot_username}/{s.miniapp_short_name}?startapp={referral_param(user)}",
        "invited": total,
        "rewarded": rewarded,
        "days_earned": rewarded * s.referral_bonus_days,
    }


async def deactivate_promo(db: AsyncSession, actor: Actor, promo_id: int) -> None:
    actor.require("billing.manage_products")
    res = await db.execute(update(PromoCode).where(PromoCode.id == promo_id).values(active=False).returning(PromoCode.id))
    if res.scalar() is None:
        raise NotFound()
    await audit(db, actor, "promo.deactivate", "promo", promo_id)

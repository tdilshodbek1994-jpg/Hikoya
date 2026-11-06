"""Entitlements and the single access policy used by text, audio, files, search and AI (spec 19)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timeutil import utcnow
from app.models import Chapter, EntitlementGrant, LibraryItem, ReadingProgress, Work

PUBLIC_STATES = ("published", "delisted")
PREMIUM_POLICIES = ("PREMIUM", "PREMIUM_OR_PURCHASE")
PURCHASE_POLICIES = ("PURCHASE", "PREMIUM_OR_PURCHASE")


@dataclass
class Entitlements:
    premium_until: datetime | None = None
    premium_forever: bool = False
    work_ids: set[int] = field(default_factory=set)

    @property
    def premium(self) -> bool:
        return self.premium_forever or self.premium_until is not None


def active_grant_filter(now: datetime):
    return and_(
        EntitlementGrant.revoked_at.is_(None),
        EntitlementGrant.starts_at <= now,
        or_(EntitlementGrant.expires_at.is_(None), EntitlementGrant.expires_at > now),  # == now is expired (T-48)
    )


async def load_entitlements(db: AsyncSession, user_id: int | None, now: datetime | None = None) -> Entitlements:
    ent = Entitlements()
    if not user_id:
        return ent
    now = now or utcnow()
    grants = (
        await db.scalars(select(EntitlementGrant).where(EntitlementGrant.user_id == user_id, active_grant_filter(now)))
    ).all()
    for g in grants:
        if g.scope_type == "premium":
            if g.expires_at is None:
                ent.premium_forever = True
            elif ent.premium_until is None or g.expires_at > ent.premium_until:
                ent.premium_until = g.expires_at
        elif g.scope_type == "work":
            ent.work_ids.add(g.scope_id)
    return ent


def access_badge(work: Work, ent: Entitlements) -> str:
    """Card badge: FREE | PREMIUM | PURCHASE | INCLUDED (in current Premium) | PURCHASED."""
    if work.id in ent.work_ids:
        return "PURCHASED"
    if work.access_policy == "FREE":
        return "FREE"
    if ent.premium and work.access_policy in PREMIUM_POLICIES:
        return "INCLUDED"
    if work.access_policy == "PURCHASE":
        return "PURCHASE"
    return "PREMIUM"


@dataclass
class ChapterAccess:
    mode: str  # full | preview | unavailable
    reason: str  # free | free_sample | free_after | purchase | premium | locked | suspended | not_released
    offers: list[str] = field(default_factory=list)  # premium | purchase

    @property
    def full(self) -> bool:
        return self.mode == "full"


def chapter_policy(work: Work, chapter: Chapter, now: datetime) -> str:
    """Effective policy for a chapter: FREE or the work's paid policy."""
    if work.access_policy == "FREE":
        return "FREE"
    if chapter.access_override == "free_sample":
        return "FREE"
    if chapter.access_override == "free_after" and chapter.free_after_at and now >= chapter.free_after_at:
        return "FREE"
    return work.access_policy


def decide_chapter_access(work: Work, chapter: Chapter, ent: Entitlements, now: datetime | None = None) -> ChapterAccess:
    """Order of checks follows spec 19.5 (preview authority is handled only by the studio endpoint)."""
    now = now or utcnow()
    # 1) suspension / removal stops reading for everyone
    if work.editorial_state == "suspended" or chapter.is_deleted:
        return ChapterAccess("unavailable", "suspended")
    # 3) a published revision must exist and be released
    if (
        work.editorial_state not in PUBLIC_STATES
        or not chapter.published_revision_id
        or chapter.published_at is None
        or chapter.published_at > now
    ):
        return ChapterAccess("unavailable", "not_released")
    if chapter.access_override == "locked_until" and chapter.release_at and now < chapter.release_at:
        return ChapterAccess("preview", "not_released")
    policy = chapter_policy(work, chapter, now)
    # 4) free material
    if policy == "FREE":
        reason = "free" if work.access_policy == "FREE" else chapter.access_override
        return ChapterAccess("full", reason)
    # 5) purchase grant for this work (kept even if the work later became PREMIUM-only)
    if work.id in ent.work_ids:
        return ChapterAccess("full", "purchase")
    # 6) premium grant only for PREMIUM / PREMIUM_OR_PURCHASE catalogue
    if ent.premium and policy in PREMIUM_POLICIES:
        return ChapterAccess("full", "premium")
    # 7) locked
    offers = []
    if policy in PREMIUM_POLICIES:
        offers.append("premium")
    if policy in PURCHASE_POLICIES:
        offers.append("purchase")
    return ChapterAccess("preview", "locked", offers)


async def can_see_work_page(db: AsyncSession, work: Work, user_id: int | None, ent: Entitlements) -> bool:
    """Catalogue visibility is separate from reading rights (delisted stays open to earlier readers)."""
    if work.editorial_state == "published" and work.visibility == "public":
        return True
    if work.editorial_state == "suspended":
        # page stays visible to people who had it, with the explanation
        pass
    elif work.editorial_state not in PUBLIC_STATES:
        return False
    if not user_id:
        return False
    if work.id in ent.work_ids:
        return True
    had = await db.scalar(
        select(
            exists().where(ReadingProgress.user_id == user_id, ReadingProgress.work_id == work.id)
            | exists().where(LibraryItem.user_id == user_id, LibraryItem.work_id == work.id)
        )
    )
    return bool(had)


def catalog_visible_clause():
    """SQL filter for public catalogue listings."""
    return and_(Work.editorial_state == "published", Work.visibility == "public")

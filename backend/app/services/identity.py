from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import Forbidden, Unauthorized
from app.core.permissions import PROTECTED_ROLES, ROLES, expand
from app.core.security import TelegramIdentity, hash_token, new_token
from app.core.text import normalize_for_search, slugify
from app.core.timeutil import utcnow
from app.models import (
    AuditLog,
    AuthorMembership,
    AuthorProfile,
    NotificationPreference,
    RoleGrant,
    Session,
    User,
    Work,
    WorkContributor,
)


@dataclass
class Actor:
    user: User
    perms: set[str] = field(default_factory=set)
    work_perms: dict[int, set[str]] = field(default_factory=dict)
    roles: set[str] = field(default_factory=set)
    author_ids: set[int] = field(default_factory=set)
    own_author_id: int | None = None
    trusted_author: bool = False
    request_id: str = ""

    @property
    def id(self) -> int:
        return self.user.id

    def has(self, perm: str) -> bool:
        return perm in self.perms

    def require(self, perm: str) -> None:
        if perm not in self.perms:
            raise Forbidden("Bu amal uchun vakolat yo'q", code="permission_denied", permission=perm)

    @property
    def is_staff(self) -> bool:
        return bool(self.roles - {"author"}) or bool(self.perms - ROLES["author"])


async def load_actor(db: AsyncSession, user: User, request_id: str = "") -> Actor:
    actor = Actor(user=user, request_id=request_id)
    if user.telegram_user_id in get_settings().owner_telegram_ids:
        actor.roles.add("owner")
        actor.perms |= ROLES["owner"]
    grants = (
        await db.scalars(select(RoleGrant).where(RoleGrant.user_id == user.id, RoleGrant.revoked_at.is_(None)))
    ).all()
    for g in grants:
        perms = expand(g.role, g.permission)
        if g.scope_type == "global":
            actor.perms |= perms
            if g.role:
                actor.roles.add(g.role)
        elif g.scope_type == "work" and g.scope_id:
            actor.work_perms.setdefault(g.scope_id, set()).update(perms)
    own = await db.scalar(select(AuthorProfile).where(AuthorProfile.user_id == user.id))
    if own:
        actor.own_author_id = own.id
        actor.author_ids.add(own.id)
        actor.trusted_author = own.publish_policy == "trusted"
        # an author profile implies the author role
        actor.perms |= ROLES["author"]
        actor.roles.add("author")
    members = (await db.scalars(select(AuthorMembership.author_id).where(AuthorMembership.user_id == user.id))).all()
    actor.author_ids.update(members)
    return actor


async def is_work_author(db: AsyncSession, actor: Actor, work: Work) -> bool:
    if not actor.author_ids:
        return False
    if work.primary_author_id in actor.author_ids:
        return True
    hit = await db.scalar(
        select(WorkContributor.id).where(
            WorkContributor.work_id == work.id, WorkContributor.author_id.in_(actor.author_ids)
        )
    )
    return hit is not None


async def can_edit_work(db: AsyncSession, actor: Actor, work: Work) -> bool:
    if actor.has("work.edit_any"):
        return True
    if "work.edit_assigned" in actor.work_perms.get(work.id, set()):
        return True
    return actor.has("work.edit_own") and await is_work_author(db, actor, work)


async def require_edit_work(db: AsyncSession, actor: Actor, work: Work) -> None:
    if not await can_edit_work(db, actor, work):
        # 404 rather than 403 so draft existence does not leak (T-36)
        from app.core.errors import NotFound

        raise NotFound("Asar topilmadi")


async def can_publish_work(db: AsyncSession, actor: Actor, work: Work) -> bool:
    if actor.has("work.publish"):
        return True
    if "work.publish" in actor.work_perms.get(work.id, set()):
        return True
    return actor.trusted_author and await is_work_author(db, actor, work)


async def can_review_work(db: AsyncSession, actor: Actor, work: Work) -> bool:
    if actor.has("work.publish") or actor.has("work.review"):
        return True
    return bool({"work.review", "work.publish"} & actor.work_perms.get(work.id, set()))


async def upsert_user(db: AsyncSession, ident: TelegramIdentity) -> User:
    user = await db.scalar(select(User).where(User.telegram_user_id == ident.telegram_user_id))
    name = (ident.first_name + " " + ident.last_name).strip() or "O'quvchi"
    s = get_settings()
    if user is None:
        user = User(
            telegram_user_id=ident.telegram_user_id,
            display_name=name,
            language="uz",
            script="cyrl" if ident.language_code in ("ru", "uz-cyrl") else "latn",
            is_test=ident.telegram_user_id in s.test_telegram_ids,
        )
        db.add(user)
        await db.flush()
        db.add(NotificationPreference(user_id=user.id, quiet_start=s.quiet_hours_start, quiet_end=s.quiet_hours_end))
    else:
        user.display_name = name
    if user.status == "blocked":
        raise Unauthorized("Hisob bloklangan", code="account_blocked")
    user.last_seen_at = utcnow()
    return user


async def get_or_create_user_by_tg(db: AsyncSession, telegram_user_id: int, name: str = "", lang: str = "") -> User:
    ident = TelegramIdentity(telegram_user_id, name, "", lang, False, "", 0)
    return await upsert_user(db, ident)


async def create_session(db: AsyncSession, user: User, device_label: str = "") -> tuple[str, Session]:
    token = new_token()
    sess = Session(
        user_id=user.id,
        token_hash=hash_token(token),
        expires_at=utcnow() + timedelta(hours=get_settings().session_ttl_hours),
        device_label=device_label[:128],
    )
    db.add(sess)
    await db.flush()
    return token, sess


async def resolve_session(db: AsyncSession, token: str) -> tuple[User, Session]:
    sess = await db.scalar(select(Session).where(Session.token_hash == hash_token(token)))
    now = utcnow()
    if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
        raise Unauthorized("Sessiya tugagan", code="session_expired")
    user = await db.get(User, sess.user_id)
    if user is None or user.status == "blocked":
        raise Unauthorized("Hisob faol emas", code="account_blocked")
    # sliding expiry: reading for a long time never forces re-login
    if (sess.expires_at - now) < timedelta(hours=get_settings().session_ttl_hours / 2):
        sess.expires_at = now + timedelta(hours=get_settings().session_ttl_hours)
    sess.last_used_at = now
    return user, sess


async def audit(
    db: AsyncSession,
    actor: Actor | None,
    action: str,
    target_type: str,
    target_id: object,
    before: dict | None = None,
    after: dict | None = None,
    reason: str = "",
    on_behalf_of_author_id: int | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_user_id=actor.id if actor else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            before=before,
            after=after,
            reason=reason[:2000],
            request_id=actor.request_id if actor else "",
            on_behalf_of_author_id=on_behalf_of_author_id,
        )
    )


async def grant_role(
    db: AsyncSession, actor: Actor, target: User, role: str, scope_type: str = "global", scope_id: int | None = None
) -> RoleGrant:
    actor.require("roles.manage")
    if role not in ROLES:
        from app.core.errors import Invalid

        raise Invalid("Noma'lum rol", code="unknown_role")
    if role in PROTECTED_ROLES and "owner" not in actor.roles:
        raise Forbidden("Egasi rolini faqat egasi beradi", code="owner_only")
    existing = await db.scalar(
        select(RoleGrant).where(
            RoleGrant.user_id == target.id,
            RoleGrant.role == role,
            RoleGrant.scope_type == scope_type,
            RoleGrant.scope_id.is_(scope_id) if scope_id is None else RoleGrant.scope_id == scope_id,
            RoleGrant.revoked_at.is_(None),
        )
    )
    if existing:
        return existing
    g = RoleGrant(user_id=target.id, role=role, scope_type=scope_type, scope_id=scope_id, granted_by=actor.id)
    db.add(g)
    if role == "author":
        await ensure_author_profile(db, target)
    await db.flush()
    await audit(db, actor, "role.grant", "user", target.id, after={"role": role, "scope": scope_type, "scope_id": scope_id})
    return g


async def revoke_role(db: AsyncSession, actor: Actor, target: User, role: str) -> int:
    actor.require("roles.manage")
    if role in PROTECTED_ROLES and "owner" not in actor.roles:
        raise Forbidden("Egasi rolini faqat egasi oladi", code="owner_only")
    grants = (
        await db.scalars(
            select(RoleGrant).where(RoleGrant.user_id == target.id, RoleGrant.role == role, RoleGrant.revoked_at.is_(None))
        )
    ).all()
    for g in grants:
        g.revoked_at = utcnow()
    await audit(db, actor, "role.revoke", "user", target.id, before={"role": role})
    return len(grants)


async def ensure_author_profile(db: AsyncSession, user: User, pen_name: str | None = None) -> AuthorProfile:
    prof = await db.scalar(select(AuthorProfile).where(AuthorProfile.user_id == user.id))
    if prof:
        return prof
    name = pen_name or user.display_name or "Muallif"
    base = slugify(name)
    slug = base
    i = 1
    while await db.scalar(select(AuthorProfile.id).where(AuthorProfile.slug == slug)):
        i += 1
        slug = f"{base}-{i}"
    prof = AuthorProfile(user_id=user.id, pen_name=name, slug=slug, search_text=normalize_for_search(name))
    db.add(prof)
    await db.flush()
    return prof


async def find_user(db: AsyncSession, ref: str) -> User | None:
    """Look up by internal id or Telegram id (never by username: spec section 4)."""
    ref = ref.strip()
    if not ref.lstrip("-").isdigit():
        return None
    n = int(ref)
    return await db.scalar(select(User).where(or_(User.telegram_user_id == n, User.id == n)))

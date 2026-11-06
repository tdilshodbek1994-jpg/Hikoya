from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.deps import DB, CurActor, Ents
from app.config import get_settings
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.security import TelegramIdentity, validate_init_data
from app.core.timeutil import utcnow
from app.models import AuthorProfile, Genre, Notification, NotificationPreference, Session, Subscription
from app.services.identity import create_session, load_actor, upsert_user

router = APIRouter(tags=["auth"])


class TelegramAuthIn(BaseModel):
    init_data: str = Field(max_length=8192)
    device_label: str = ""


class DevAuthIn(BaseModel):
    telegram_user_id: int
    first_name: str = "Dev"


async def _session_response(db, user, start_param: str, device: str) -> dict:
    token, sess = await create_session(db, user, device)
    actor = await load_actor(db, user)
    return {"token": token, "session_id": sess.id, "expires_at": sess.expires_at.isoformat(), "start_param": start_param, "me": await me_dto(db, actor)}


@router.post("/auth/telegram")
async def auth_telegram(body: TelegramAuthIn, db: DB):
    """Validate raw initData on the server (initDataUnsafe is never trusted) and open a session."""
    s = get_settings()
    ident = validate_init_data(body.init_data, s.bot_token, s.init_data_max_age_seconds)
    user = await upsert_user(db, ident)
    return await _session_response(db, user, ident.start_param, body.device_label)


@router.post("/auth/dev")
async def auth_dev(body: DevAuthIn, db: DB):
    """Local development only. Disabled unless HIKOYA_DEV_AUTH_ENABLED=true (refused in production)."""
    s = get_settings()
    if not s.dev_auth_enabled or s.is_production:
        raise NotFound()
    ident = TelegramIdentity(body.telegram_user_id, body.first_name, "", "uz", False, "", 0)
    user = await upsert_user(db, ident)
    return await _session_response(db, user, "", "dev")


async def me_dto(db, actor) -> dict:
    u = actor.user
    prof = await db.get(AuthorProfile, actor.own_author_id) if actor.own_author_id else None
    unread = await db.scalar(select(func.count()).select_from(Notification).where(Notification.user_id == u.id, Notification.read_at.is_(None)))
    prefs = await db.get(NotificationPreference, u.id)
    return {
        "id": u.id,
        "display_name": u.display_name,
        "language": u.language,
        "script": u.script,
        "onboarding_done": u.onboarding_done,
        "favorite_genre_ids": u.favorite_genre_ids,
        "reader_settings": u.reader_settings or {},
        "only_completed": u.only_completed,
        "daily_goal_minutes": u.daily_goal_minutes,
        "bot_messages_allowed": u.bot_messages_allowed,
        "roles": sorted(actor.roles),
        "permissions": sorted(actor.perms),
        "assigned_work_ids": sorted(actor.work_perms),
        "is_staff": actor.is_staff,
        "author": ({"id": prof.id, "pen_name": prof.pen_name, "slug": prof.slug, "trusted": prof.publish_policy == "trusted"} if prof else None),
        "unread_notifications": unread or 0,
        "notification_prefs": (
            {"mode": prefs.mode, "quiet_start": prefs.quiet_start, "quiet_end": prefs.quiet_end, "disabled_types": prefs.disabled_types} if prefs else None
        ),
    }


@router.get("/me")
async def get_me(db: DB, actor: CurActor):
    return await me_dto(db, actor)


class PrefsIn(BaseModel):
    script: str | None = None
    favorite_genre_ids: list[int] | None = None
    onboarding_done: bool | None = None
    reader_settings: dict | None = None
    only_completed: bool | None = None
    daily_goal_minutes: int | None = None
    notification_mode: str | None = None
    quiet_start: str | None = None
    quiet_end: str | None = None
    disabled_types: list[str] | None = None
    bot_messages_allowed: bool | None = None


READER_KEYS = {"theme": {"light", "dark", "sepia"}, "font": {"serif", "sans"}}


@router.patch("/me/preferences")
async def patch_prefs(body: PrefsIn, db: DB, actor: CurActor):
    u = actor.user
    if body.script is not None:
        if body.script not in ("latn", "cyrl"):
            raise Invalid("Noto'g'ri yozuv")
        u.script = body.script
    if body.favorite_genre_ids is not None:
        ids = list(dict.fromkeys(body.favorite_genre_ids))[:3]
        if ids and len((await db.scalars(select(Genre.id).where(Genre.id.in_(ids)))).all()) != len(ids):
            raise Invalid("Janr topilmadi")
        u.favorite_genre_ids = ids
    if body.onboarding_done is not None:
        u.onboarding_done = body.onboarding_done
    if body.reader_settings is not None:
        rs = dict(u.reader_settings or {})
        for k, v in body.reader_settings.items():
            if k in READER_KEYS and v in READER_KEYS[k]:
                rs[k] = v
            elif k == "font_size" and isinstance(v, (int, float)) and 16 <= v <= 28:
                rs[k] = int(v)
            elif k == "line_height" and isinstance(v, (int, float)) and 1.2 <= v <= 2.2:
                rs[k] = round(float(v), 2)
            elif k == "width" and v in ("narrow", "normal", "wide"):
                rs[k] = v
            elif k == "show_progress" and isinstance(v, bool):
                rs[k] = v
            elif k == "original_script" and isinstance(v, bool):
                rs[k] = v
        u.reader_settings = rs
    if body.only_completed is not None:
        u.only_completed = body.only_completed
    if body.daily_goal_minutes is not None:
        u.daily_goal_minutes = body.daily_goal_minutes if 0 < body.daily_goal_minutes <= 600 else None
    if body.bot_messages_allowed is not None:
        u.bot_messages_allowed = body.bot_messages_allowed
    prefs = await db.get(NotificationPreference, u.id)
    if prefs is None:
        prefs = NotificationPreference(user_id=u.id)
        db.add(prefs)
    if body.notification_mode in ("instant", "digest"):
        prefs.mode = body.notification_mode
    import re

    for attr in ("quiet_start", "quiet_end"):
        v = getattr(body, attr)
        if v is not None:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
                raise Invalid("Vaqt formati HH:MM")
            setattr(prefs, attr, v)
    if body.disabled_types is not None:
        prefs.disabled_types = [t for t in body.disabled_types if t in ("new_chapter", "new_work", "comment_reply", "work_completed", "digest")]
    await db.flush()
    return await me_dto(db, actor)


@router.get("/me/entitlements")
async def my_entitlements(db: DB, actor: CurActor, ent: Ents):
    subs = (await db.scalars(select(Subscription).where(Subscription.user_id == actor.id).order_by(Subscription.id.desc()))).all()
    return {
        "premium": ent.premium,
        "premium_until": ent.premium_until.isoformat() if ent.premium_until else None,
        "work_ids": sorted(ent.work_ids),
        "subscriptions": [
            {"id": s.id, "renewal_state": s.renewal_state, "paid_until": s.paid_until.isoformat() if s.paid_until else None} for s in subs
        ],
        "note": "Telegram Premium belgisi HIKOYA PRO obunasi emas",
    }


@router.get("/me/sessions")
async def my_sessions(db: DB, actor: CurActor, request: Request):
    rows = (await db.scalars(select(Session).where(Session.user_id == actor.id, Session.revoked_at.is_(None), Session.expires_at > utcnow()))).all()
    cur = getattr(request.state, "session_id", None)
    return [{"id": s.id, "device": s.device_label, "created_at": s.created_at.isoformat(), "current": s.id == cur} for s in rows]


@router.delete("/me/sessions/{session_id}")
async def revoke_session(session_id: int, db: DB, actor: CurActor):
    s = await db.get(Session, session_id)
    if s is None or s.user_id != actor.id:
        raise Forbidden()
    s.revoked_at = utcnow()
    return {"ok": True}

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import distinct, func, select

from app.api.deps import DB, CurActor
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.permissions import ROLE_TITLES, ROLES
from app.core.text import clean_plain, lat_to_cyr, normalize_for_search, slugify
from app.core.timeutil import period_start, utcnow
from app.models import (
    AppSetting,
    AuthorProfile,
    Comment,
    CuratedCollection,
    CuratedItem,
    Genre,
    HomeSection,
    Payment,
    Product,
    ProductVersion,
    QualifiedRead,
    RoleGrant,
    SupportMessage,
    SupportTicket,
    Tag,
    User,
    Work,
)
from app.services import social
from app.services.billing import current_version
from app.services.catalog import invalidate_cache
from app.services.identity import audit, find_user, grant_role, revoke_role

router = APIRouter(prefix="/admin", tags=["admin"])


# --- genres & tags ---


class GenreIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    slug: str | None = None
    emoji: str = ""
    synonyms: list[str] = Field(default_factory=list)
    sort_order: int | None = None
    active: bool = True
    cover_asset_id: int | None = None


@router.get("/genres")
async def genres(db: DB, actor: CurActor):
    actor.require("catalog.manage")
    rows = (await db.scalars(select(Genre).order_by(Genre.sort_order, Genre.id))).all()
    return [{"id": g.id, "slug": g.slug, "name": g.name_latn, "emoji": g.emoji, "synonyms": g.synonyms, "sort_order": g.sort_order, "active": g.active} for g in rows]


@router.post("/genres")
async def add_genre(body: GenreIn, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    slug = body.slug or slugify(body.name)
    if await db.scalar(select(Genre.id).where(Genre.slug == slug)):
        raise Invalid("Bunday janr bor", code="duplicate")
    max_sort = await db.scalar(select(func.max(Genre.sort_order))) or 0
    g = Genre(slug=slug, name_latn=body.name, name_cyrl=lat_to_cyr(body.name), emoji=body.emoji, synonyms=body.synonyms, sort_order=body.sort_order if body.sort_order is not None else max_sort + 10, active=body.active, cover_asset_id=body.cover_asset_id)
    db.add(g)
    await db.flush()
    await audit(db, actor, "genre.create", "genre", g.id, after={"name": body.name})
    invalidate_cache()
    return {"id": g.id}


@router.patch("/genres/{gid}")
async def edit_genre(gid: int, body: GenreIn, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    g = await db.get(Genre, gid)
    if g is None:
        raise NotFound()
    g.name_latn, g.name_cyrl, g.emoji, g.synonyms, g.active = body.name, lat_to_cyr(body.name), body.emoji, body.synonyms, body.active
    if body.sort_order is not None:
        g.sort_order = body.sort_order
    if body.cover_asset_id is not None:
        g.cover_asset_id = body.cover_asset_id
    await audit(db, actor, "genre.update", "genre", g.id)
    invalidate_cache()
    return {"ok": True}


class TagIn(BaseModel):
    name: str
    kind: str = "general"


@router.post("/tags")
async def add_tag(body: TagIn, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    if body.kind not in ("general", "mood", "content"):
        raise Invalid()
    t = Tag(slug=slugify(body.name), name_latn=body.name, name_cyrl=lat_to_cyr(body.name), kind=body.kind)
    db.add(t)
    await db.flush()
    return {"id": t.id}


# --- home page ---


class SectionIn(BaseModel):
    key: str | None = None
    kind: str | None = None
    title: str | None = None
    sort_order: int | None = None
    active: bool | None = None
    starts_at: str | None = None
    ends_at: str | None = None
    max_items: int | None = None
    filter: dict | None = None
    allow_duplicates: bool | None = None


KINDS = {"stories", "genres", "continue", "editorial", "top", "for_you", "new_chapters", "premium", "rail"}


@router.get("/home-sections")
async def sections(db: DB, actor: CurActor):
    actor.require("catalog.manage")
    rows = (await db.scalars(select(HomeSection).order_by(HomeSection.sort_order, HomeSection.id))).all()
    return [{"id": s.id, "key": s.key, "kind": s.kind, "title": s.title_latn, "sort_order": s.sort_order, "active": s.active, "starts_at": s.starts_at.isoformat() if s.starts_at else None, "ends_at": s.ends_at.isoformat() if s.ends_at else None, "max_items": s.max_items, "filter": s.filter, "allow_duplicates": s.allow_duplicates} for s in rows]


def _dt(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


@router.post("/home-sections")
async def add_section(body: SectionIn, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    if not body.key or body.kind not in KINDS or not body.title:
        raise Invalid("key, kind va title kerak")
    s = HomeSection(key=slugify(body.key, 48), kind=body.kind, title_latn=body.title, title_cyrl=lat_to_cyr(body.title), sort_order=body.sort_order or 999, active=body.active if body.active is not None else True, starts_at=_dt(body.starts_at), ends_at=_dt(body.ends_at), max_items=max(1, min(body.max_items or 12, 30)), filter=body.filter or {}, allow_duplicates=bool(body.allow_duplicates))
    db.add(s)
    await db.flush()
    await audit(db, actor, "home.section_create", "home_section", s.id)
    return {"id": s.id}


@router.patch("/home-sections/{sid}")
async def edit_section(sid: int, body: SectionIn, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    s = await db.get(HomeSection, sid)
    if s is None:
        raise NotFound()
    if body.title is not None:
        s.title_latn, s.title_cyrl = body.title, lat_to_cyr(body.title)
    for k in ("sort_order", "active", "filter", "allow_duplicates"):
        v = getattr(body, k)
        if v is not None:
            setattr(s, k, v)
    if body.max_items is not None:
        s.max_items = max(1, min(body.max_items, 30))
    if body.starts_at is not None:
        s.starts_at = _dt(body.starts_at)
    if body.ends_at is not None:
        s.ends_at = _dt(body.ends_at)
    await audit(db, actor, "home.section_update", "home_section", s.id, after=body.model_dump(exclude_none=True))
    return {"ok": True}


class CuratedIn(BaseModel):
    work_id: int
    reason: str = Field("", max_length=200)
    sort_key: int = 0
    sponsored: bool = False


@router.get("/curated/{slug}")
async def curated(slug: str, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    c = await db.scalar(select(CuratedCollection).where(CuratedCollection.slug == slug))
    if c is None:
        raise NotFound()
    rows = (await db.execute(select(CuratedItem, Work.title).join(Work, Work.id == CuratedItem.work_id).where(CuratedItem.collection_id == c.id).order_by(CuratedItem.sort_key))).all()
    return {"id": c.id, "title": c.title, "items": [{"id": i.id, "work_id": i.work_id, "title": t, "reason": i.reason, "sponsored": i.sponsored, "sort_key": i.sort_key} for i, t in rows]}


@router.post("/curated/{slug}")
async def add_curated(slug: str, body: CuratedIn, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    c = await db.scalar(select(CuratedCollection).where(CuratedCollection.slug == slug))
    if c is None:
        c = CuratedCollection(slug=slugify(slug, 64), title=slug)
        db.add(c)
        await db.flush()
    from sqlalchemy.dialects.postgresql import insert

    await db.execute(
        insert(CuratedItem).values(collection_id=c.id, work_id=body.work_id, reason=clean_plain(body.reason, 200), sort_key=body.sort_key, sponsored=body.sponsored).on_conflict_do_update(index_elements=["collection_id", "work_id"], set_={"reason": clean_plain(body.reason, 200), "sort_key": body.sort_key, "sponsored": body.sponsored})
    )
    await audit(db, actor, "curated.add", "curated", c.id, after=body.model_dump())
    invalidate_cache()
    return {"ok": True}


@router.delete("/curated/{slug}/{work_id}")
async def remove_curated(slug: str, work_id: int, db: DB, actor: CurActor):
    actor.require("catalog.manage")
    c = await db.scalar(select(CuratedCollection).where(CuratedCollection.slug == slug))
    if c:
        from sqlalchemy import delete

        await db.execute(delete(CuratedItem).where(CuratedItem.collection_id == c.id, CuratedItem.work_id == work_id))
    return {"ok": True}


# --- staff, users, authors ---


@router.get("/roles")
async def roles(db: DB, actor: CurActor):
    actor.require("roles.manage")
    rows = (await db.execute(select(RoleGrant, User).join(User, User.id == RoleGrant.user_id).where(RoleGrant.revoked_at.is_(None)).order_by(RoleGrant.id))).all()
    return {
        "available": [{"role": r, "title": ROLE_TITLES[r], "permissions": sorted(p)} for r, p in ROLES.items()],
        "grants": [{"id": g.id, "user_id": u.id, "telegram_user_id": u.telegram_user_id, "name": u.display_name, "role": g.role, "permission": g.permission, "scope_type": g.scope_type, "scope_id": g.scope_id} for g, u in rows],
    }


class GrantIn(BaseModel):
    user_ref: str  # internal id or Telegram id (never username)
    role: str
    scope_type: str = "global"
    scope_id: int | None = None


@router.post("/roles")
async def grant(body: GrantIn, db: DB, actor: CurActor):
    target = await find_user(db, body.user_ref)
    if target is None:
        raise NotFound("Foydalanuvchi topilmadi. U avval botni ochgan bo'lishi kerak.")
    g = await grant_role(db, actor, target, body.role, body.scope_type, body.scope_id)
    return {"id": g.id}


@router.delete("/roles")
async def revoke(user_ref: str, role: str, db: DB, actor: CurActor):
    target = await find_user(db, user_ref)
    if target is None:
        raise NotFound()
    return {"revoked": await revoke_role(db, actor, target, role)}


@router.get("/users")
async def users(db: DB, actor: CurActor, q: str = ""):
    if not (actor.has("roles.manage") or actor.has("support.handle") or actor.has("comment.moderate")):
        raise Forbidden()
    query = select(User)
    if q.strip().isdigit():
        n = int(q)
        query = query.where((User.telegram_user_id == n) | (User.id == n))
    elif q.strip():
        query = query.where(User.display_name.ilike(f"%{q.strip()}%"))
    rows = (await db.scalars(query.order_by(User.id.desc()).limit(50))).all()
    return [{"id": u.id, "telegram_user_id": u.telegram_user_id, "name": u.display_name, "status": u.status, "is_test": u.is_test, "created_at": u.created_at.isoformat()} for u in rows]


class UserPatch(BaseModel):
    status: str | None = None
    is_test: bool | None = None
    reason: str = ""


@router.patch("/users/{uid}")
async def patch_user(uid: int, body: UserPatch, db: DB, actor: CurActor):
    actor.require("roles.manage")
    u = await db.get(User, uid)
    if u is None:
        raise NotFound()
    before = {"status": u.status, "is_test": u.is_test}
    if body.status in ("active", "blocked"):
        if not body.reason.strip():
            raise Invalid("Sabab kerak", code="reason_required")
        u.status = body.status
    if body.is_test is not None:
        u.is_test = body.is_test
    await audit(db, actor, "user.update", "user", u.id, before=before, after=body.model_dump(exclude_none=True), reason=body.reason)
    return {"ok": True}


class AuthorIn(BaseModel):
    pen_name: str = Field(min_length=1, max_length=128)
    bio: str = ""
    user_ref: str | None = None


@router.post("/authors")
async def create_author(body: AuthorIn, db: DB, actor: CurActor):
    actor.require("author.manage")
    user = await find_user(db, body.user_ref) if body.user_ref else None
    if user and await db.scalar(select(AuthorProfile.id).where(AuthorProfile.user_id == user.id)):
        raise Invalid("Bu foydalanuvchida muallif profili bor", code="duplicate")
    base = slugify(body.pen_name)
    slug, i = base, 1
    while await db.scalar(select(AuthorProfile.id).where(AuthorProfile.slug == slug)):
        i += 1
        slug = f"{base}-{i}"
    a = AuthorProfile(user_id=user.id if user else None, pen_name=body.pen_name, slug=slug, bio=clean_plain(body.bio, 2000), search_text=normalize_for_search(body.pen_name))
    db.add(a)
    await db.flush()
    await audit(db, actor, "author.create", "author", a.id)
    return {"id": a.id}


class AuthorPatch(BaseModel):
    pen_name: str | None = None
    bio: str | None = None
    verification_status: str | None = None
    publish_policy: str | None = None
    editorial_featured: bool | None = None
    next_release_note: str | None = None
    avatar_asset_id: int | None = None


@router.get("/authors")
async def authors(db: DB, actor: CurActor, q: str = ""):
    if not (actor.has("author.manage") or actor.has("author.post_as")):
        raise Forbidden()
    query = select(AuthorProfile)
    if q.strip():
        query = query.where(AuthorProfile.search_text.ilike(f"%{normalize_for_search(q)}%"))
    rows = (await db.scalars(query.order_by(AuthorProfile.pen_name).limit(100))).all()
    return [{"id": a.id, "pen_name": a.pen_name, "user_id": a.user_id, "verified": a.verification_status == "verified", "trusted": a.publish_policy == "trusted", "featured": a.editorial_featured, "is_demo": a.is_demo} for a in rows]


@router.patch("/authors/{aid}")
async def patch_author(aid: int, body: AuthorPatch, db: DB, actor: CurActor):
    a = await db.get(AuthorProfile, aid)
    if a is None:
        raise NotFound()
    own = aid in actor.author_ids
    staff_fields = {"verification_status", "publish_policy", "editorial_featured"}
    data = body.model_dump(exclude_none=True)
    if staff_fields & set(data):
        actor.require("author.manage")
    elif not own:
        actor.require("author.manage")
    if "verification_status" in data and data["verification_status"] not in ("none", "verified"):
        raise Invalid()
    if "publish_policy" in data and data["publish_policy"] not in ("review", "trusted"):
        raise Invalid()
    for k, v in data.items():
        if k == "avatar_asset_id":
            from app.models import Asset
            from app.services.assets import set_author_avatar

            asset = await db.get(Asset, v)
            if asset is None or asset.kind != "image":
                raise Invalid("Rasm kerak")
            await set_author_avatar(db, a, asset)
            continue
        if k in ("bio", "next_release_note"):
            v = clean_plain(v, 2000)
        setattr(a, k, v)
        if k == "pen_name":
            a.search_text = normalize_for_search(v)
    await audit(db, actor, "author.update", "author", a.id, after=data)
    return {"ok": True}


# --- moderation & support ---


@router.get("/moderation")
async def moderation(db: DB, actor: CurActor):
    return await social.moderation_queue(db, actor)


class ModIn(BaseModel):
    target_type: str
    target_id: int
    action: str
    reason: str


@router.post("/moderation")
async def moderate(body: ModIn, db: DB, actor: CurActor):
    m = await social.moderate(db, actor, body.target_type, body.target_id, body.action, body.reason)
    return {"id": m.id}


@router.get("/support")
async def tickets(db: DB, actor: CurActor, status: str = "open"):
    actor.require("support.handle")
    rows = (await db.scalars(select(SupportTicket).where(SupportTicket.status == status).order_by(SupportTicket.id).limit(100))).all()
    out = []
    for t in rows:
        msgs = (await db.scalars(select(SupportMessage).where(SupportMessage.ticket_id == t.id).order_by(SupportMessage.id))).all()
        out.append({"id": t.id, "user_id": t.user_id, "category": t.category, "subject": t.subject, "order_id": t.order_id, "payment_id": t.payment_id, "status": t.status, "messages": [{"body": m.body, "staff": m.is_staff, "at": m.created_at.isoformat()} for m in msgs]})
    return out


class TicketReply(BaseModel):
    body: str = ""
    status: str | None = None


@router.post("/support/{tid}")
async def reply_ticket(tid: int, body: TicketReply, db: DB, actor: CurActor):
    actor.require("support.handle")
    t = await db.get(SupportTicket, tid)
    if t is None:
        raise NotFound()
    if body.body.strip():
        db.add(SupportMessage(ticket_id=t.id, author_user_id=actor.id, is_staff=True, body=clean_plain(body.body, 4000)))
        from app.services.notify import notify

        await notify(db, t.user_id, "system", f"support_reply:{t.id}:{utcnow().timestamp()}", "Murojaatingizga javob berildi", body.body[:200], "support", service=True)
    if body.status in ("open", "in_progress", "resolved", "closed"):
        t.status = body.status
    t.assignee_id = actor.id
    await audit(db, actor, "support.reply", "ticket", t.id, after={"status": t.status})
    return {"ok": True}


# --- stats (only real, computed numbers) ---


@router.get("/stats")
async def stats(db: DB, actor: CurActor):
    actor.require("stats.view_all")
    now = utcnow()
    day = period_start("today", now)
    week = period_start("week", now)
    users_total = await db.scalar(select(func.count()).select_from(User).where(User.is_test.is_(False)))
    users_new_week = await db.scalar(select(func.count()).select_from(User).where(User.created_at >= week, User.is_test.is_(False)))
    active_day = await db.scalar(select(func.count()).select_from(User).where(User.last_seen_at >= day, User.is_test.is_(False)))
    works_pub = await db.scalar(select(func.count()).select_from(Work).where(Work.editorial_state == "published", Work.is_demo.is_(False)))
    works_demo = await db.scalar(select(func.count()).select_from(Work).where(Work.is_demo.is_(True)))
    readers_week = await db.scalar(select(func.count(distinct(QualifiedRead.user_id))).where(QualifiedRead.qualified_at >= week))
    comments_week = await db.scalar(select(func.count()).select_from(Comment).where(Comment.created_at >= week))
    data = {
        "computed_at": now.isoformat(),
        "users_total": users_total,
        "users_new_this_week": users_new_week,
        "active_today": active_day,
        "works_published_real": works_pub,
        "works_demo": works_demo,
        "unique_qualified_readers_this_week": readers_week,
        "comments_this_week": comments_week,
        "note": "Demo asarlar va test akkauntlar real ko'rsatkichlardan ajratilgan.",
    }
    if actor.has("billing.view"):
        rows = (await db.execute(select(Payment.state, func.count(), func.coalesce(func.sum(Payment.amount), 0)).where(Payment.created_at >= now - timedelta(days=30)).group_by(Payment.state))).all()
        data["payments_30d"] = [{"state": r[0], "count": r[1], "stars": int(r[2])} for r in rows]
    return data


@router.get("/products")
async def products(db: DB, actor: CurActor):
    actor.require("billing.view")
    out = []
    for p in (await db.scalars(select(Product).order_by(Product.sort_order, Product.id))).all():
        v = await current_version(db, p)
        last = await db.scalar(select(ProductVersion).where(ProductVersion.product_id == p.id).order_by(ProductVersion.version.desc()).limit(1))
        out.append({"id": p.id, "sku": p.sku, "title": p.title, "pricing_type": p.pricing_type, "active": p.active, "amount": (v or last).amount if (v or last) else None, "is_demo": (v or last).is_demo if (v or last) else True, "version": (v or last).version if (v or last) else None})
    return out


class SettingIn(BaseModel):
    value: dict


@router.put("/settings/{key}")
async def put_setting(key: str, body: SettingIn, db: DB, actor: CurActor):
    actor.require("settings.manage")
    from sqlalchemy.dialects.postgresql import insert

    await db.execute(insert(AppSetting).values(key=key[:64], value=body.value).on_conflict_do_update(index_elements=["key"], set_={"value": body.value}))
    await audit(db, actor, "settings.update", "setting", key, after=body.value)
    return {"ok": True}

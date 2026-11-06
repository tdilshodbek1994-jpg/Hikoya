"""Stage C endpoints: characters, recap, beta readers, quote cards, gifts, royalties, AI."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.deps import DB, CurActor, Ents, OptActor, limiter
from app.core.errors import NotFound
from app.core.text import clean_plain
from app.models import AuthorProfile, AuthorStory, Chapter, Character, RoyaltyEntry, Work
from app.services import ai
from app.services import billing as billing_svc
from app.services import companion
from app.services import quotes as quote_svc
from app.services import stories as story_svc
from app.services.access import can_see_work_page
from app.services.identity import require_edit_work

router = APIRouter(tags=["extras"])


async def _visible_work(db, actor, ent, work_id: int) -> Work:
    w = await db.get(Work, work_id)
    if w is None or not await can_see_work_page(db, w, actor.id if actor else None, ent):
        raise NotFound("Asar topilmadi")
    return w


async def _editable_work(db, actor, work_id: int) -> Work:
    w = await db.get(Work, work_id)
    if w is None:
        raise NotFound("Asar topilmadi")
    await require_edit_work(db, actor, w)
    return w


# ------------------------------------------------------------ characters

@router.get("/works/{work_id}/characters")
async def characters(work_id: int, db: DB, actor: OptActor, ent: Ents):
    w = await _visible_work(db, actor, ent, work_id)
    return await companion.list_characters(db, w, actor.id if actor else None)


@router.get("/studio/works/{work_id}/characters")
async def studio_characters(work_id: int, db: DB, actor: CurActor):
    w = await _editable_work(db, actor, work_id)
    return await companion.list_characters(db, w, actor.id, staff=True)


class CharacterIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    reveal_chapter_id: int | None = None
    avatar_asset_id: int | None = None
    sort_order: int | None = None


@router.post("/studio/works/{work_id}/characters")
async def add_character(work_id: int, body: CharacterIn, db: DB, actor: CurActor):
    w = await _editable_work(db, actor, work_id)
    c = await companion.save_character(db, actor, w, body.model_dump(exclude_unset=True))
    return {"id": c.id}


@router.patch("/studio/characters/{character_id}")
async def patch_character(character_id: int, body: CharacterIn, db: DB, actor: CurActor):
    c = await db.get(Character, character_id)
    if c is None:
        raise NotFound()
    w = await _editable_work(db, actor, c.work_id)
    await companion.save_character(db, actor, w, body.model_dump(exclude_unset=True), c)
    return {"ok": True}


@router.delete("/studio/characters/{character_id}")
async def del_character(character_id: int, db: DB, actor: CurActor):
    c = await db.get(Character, character_id)
    if c is None:
        raise NotFound()
    await companion.delete_character(db, actor, c)
    return {"ok": True}


# ------------------------------------------------------------ beta readers

class BetaInviteIn(BaseModel):
    chapter_id: int | None = None
    days: int = 14
    note: str = Field(default="", max_length=500)


@router.get("/studio/works/{work_id}/beta-invites")
async def beta_invites(work_id: int, db: DB, actor: CurActor):
    w = await _editable_work(db, actor, work_id)
    return {"items": await companion.list_beta_invites(db, actor, w)}


@router.post("/studio/works/{work_id}/beta-invites")
async def create_beta_invite(work_id: int, body: BetaInviteIn, db: DB, actor: CurActor):
    w = await _editable_work(db, actor, work_id)
    g = await companion.create_beta_invite(db, actor, w, body.chapter_id, body.days, body.note)
    items = await companion.list_beta_invites(db, actor, w)
    return next(i for i in items if i["id"] == g.id)


@router.delete("/studio/beta-invites/{grant_id}")
async def revoke_beta(grant_id: int, db: DB, actor: CurActor):
    await companion.revoke_beta(db, actor, grant_id)
    return {"ok": True}


@router.get("/beta/{token}")
async def beta_overview(token: str, db: DB, actor: CurActor):
    return await companion.beta_overview(db, actor.user, token[:48])


@router.get("/beta/chapters/{chapter_id}")
async def beta_chapter(chapter_id: int, db: DB, actor: CurActor):
    return await companion.beta_chapter(db, actor, chapter_id)


class BetaFeedbackIn(BaseModel):
    body: str = Field(max_length=4000)
    block_id: str = Field(default="", max_length=32)


@router.post("/beta/chapters/{chapter_id}/feedback")
async def beta_feedback(chapter_id: int, body: BetaFeedbackIn, db: DB, actor: CurActor):
    limiter.hit(f"beta:{actor.id}", 20, 60)
    n = await companion.beta_feedback(db, actor, chapter_id, body.body, body.block_id)
    return {"id": n.id}


# ------------------------------------------------------------ quotes

class QuoteIn(BaseModel):
    chapter_id: int
    block_id: str = Field(max_length=32)
    text: str = Field(max_length=1000)
    theme: str = "paper"


@router.post("/share/quote-card")
async def quote_card(body: QuoteIn, db: DB, actor: CurActor, ent: Ents):
    limiter.hit(f"quote:{actor.id}", 20, 60)
    return await quote_svc.quote_card(db, ent, body.chapter_id, body.block_id, body.text, body.theme)


@router.post("/studio/storis/quote-draft")
async def quote_story_draft(body: QuoteIn, db: DB, actor: CurActor):
    """Author one-tap: a quote from own published chapter becomes a DRAFT storis (not published)."""
    ch = await db.get(Chapter, body.chapter_id)
    if ch is None or ch.is_deleted:
        raise NotFound("Bob topilmadi")
    w = await _editable_work(db, actor, ch.work_id)
    quote = clean_plain(body.text, 700)
    await quote_svc.check_quote_in_chapter(db, ch, body.block_id, quote)
    bg = body.theme if body.theme in story_svc.BACKGROUNDS else "violet"
    s = await story_svc.create_story(
        db, actor, author_id=w.primary_author_id, caption=w.title,
        frames=[{"kind": "quote", "text": quote, "background": bg, "linked_chapter_id": ch.id, "action_type": "read"}],
        submit=False,
    )
    return {"id": s.id, "status": s.status}


@router.post("/studio/storis/{story_id}/submit")
async def submit_story(story_id: int, db: DB, actor: CurActor):
    s = await db.get(AuthorStory, story_id)
    if s is None or s.status != "draft":
        raise NotFound("Qoralama storis topilmadi")
    await story_svc.submit_story(db, actor, s)
    return {"id": s.id, "status": s.status, "expires_at": s.expires_at.isoformat() if s.expires_at else None}


# ------------------------------------------------------------ royalties

@router.get("/studio/royalties")
async def my_royalties(db: DB, actor: CurActor, author_id: int | None = None):
    aid = author_id or actor.own_author_id
    if aid is None or (aid not in actor.author_ids and not actor.has("billing.view")):
        raise NotFound("Muallif profili topilmadi")
    return await billing_svc.royalty_summary(db, aid)


@router.get("/admin/royalties")
async def royalties_overview(db: DB, actor: CurActor):
    actor.require("billing.view")
    rows = (
        await db.execute(
            select(RoyaltyEntry.author_id, AuthorProfile.pen_name, RoyaltyEntry.state, func.coalesce(func.sum(RoyaltyEntry.amount_stars), 0))
            .join(AuthorProfile, AuthorProfile.id == RoyaltyEntry.author_id)
            .group_by(RoyaltyEntry.author_id, AuthorProfile.pen_name, RoyaltyEntry.state)
        )
    ).all()
    authors: dict[int, dict] = {}
    for aid, name, state, stars in rows:
        a = authors.setdefault(aid, {"author_id": aid, "pen_name": name, "pending": 0, "available": 0, "paid": 0, "reversed": 0})
        a[state] = int(stars)
    return {"items": sorted(authors.values(), key=lambda a: -a["available"])}


class PayoutIn(BaseModel):
    note: str = Field(min_length=3, max_length=500)


@router.post("/admin/royalties/{author_id}/payout")
async def royalty_payout(author_id: int, body: PayoutIn, db: DB, actor: CurActor):
    p = await billing_svc.record_payout(db, actor, author_id, body.note)
    return {"id": p.id, "amount": p.amount_stars}


# ------------------------------------------------------------ AI

@router.get("/ai/status")
async def ai_status():
    return {"enabled": ai.ai_enabled()}


@router.post("/ai/works/{work_id}/recap")
async def ai_recap(work_id: int, db: DB, actor: CurActor, ent: Ents):
    limiter.hit(f"ai:{actor.id}", 5, 60)
    return await ai.reader_recap(db, actor.user, ent, work_id)


class NLSearchIn(BaseModel):
    text: str = Field(max_length=300)


@router.post("/ai/search")
async def ai_search(body: NLSearchIn, db: DB, actor: CurActor):
    limiter.hit(f"ai:{actor.id}", 5, 60)
    return await ai.nl_search(db, actor.user, body.text)


@router.post("/studio/ai/works/{work_id}/synopsis")
async def ai_synopsis(work_id: int, db: DB, actor: CurActor):
    limiter.hit(f"ai:{actor.id}", 5, 60)
    return await ai.synopsis_variants(db, actor, work_id)


@router.post("/studio/ai/chapters/{chapter_id}/proofread")
async def ai_proofread(chapter_id: int, db: DB, actor: CurActor):
    limiter.hit(f"ai:{actor.id}", 5, 60)
    return await ai.proofread(db, actor, chapter_id)


class ApplyIn(BaseModel):
    accepted: list[int] = Field(default_factory=list, max_length=100)


@router.post("/studio/ai/proofread/{request_id}/apply")
async def ai_apply(request_id: int, body: ApplyIn, db: DB, actor: CurActor):
    return await ai.apply_proofread(db, actor, request_id, body.accepted)



# ------------------------------------------------------------ branching stories

class ChoiceItem(BaseModel):
    label: str = Field(max_length=120)
    target_chapter_id: int


class ChoicesIn(BaseModel):
    items: list[ChoiceItem] = Field(default_factory=list, max_length=4)


async def _chapter(db, chapter_id: int) -> Chapter:
    ch = await db.get(Chapter, chapter_id)
    if ch is None or ch.is_deleted:
        raise NotFound("Bob topilmadi")
    return ch


@router.get("/studio/chapters/{chapter_id}/choices")
async def studio_choices(chapter_id: int, db: DB, actor: CurActor):
    from app.services import branching

    return {"items": await branching.studio_choices(db, actor, await _chapter(db, chapter_id))}


@router.put("/studio/chapters/{chapter_id}/choices")
async def put_choices(chapter_id: int, body: ChoicesIn, db: DB, actor: CurActor):
    from app.services import branching

    ch = await _chapter(db, chapter_id)
    await branching.set_choices(db, actor, ch, [i.model_dump() for i in body.items])
    return {"items": await branching.studio_choices(db, actor, ch)}


@router.post("/chapters/{chapter_id}/choices/{choice_id}")
async def make_choice(chapter_id: int, choice_id: int, db: DB, actor: CurActor, ent: Ents):
    from app.services import branching

    return await branching.choose(db, actor.user, ent, chapter_id, choice_id)


# ------------------------------------------------------------ audio ↔ text sync

class SyncMark(BaseModel):
    bid: str = Field(max_length=32)
    t: float


class SyncIn(BaseModel):
    marks: list[SyncMark] = Field(default_factory=list, max_length=2000)


@router.get("/studio/chapters/{chapter_id}/audio-sync")
async def get_audio_sync(chapter_id: int, db: DB, actor: CurActor):
    from app.models import AssetLink, ChapterRevision
    from app.core import content_schema as cs
    from app.services.assets import signed_media_url

    ch = await _chapter(db, chapter_id)
    await _editable_work(db, actor, ch.work_id)
    head = ch.published_revision_id or ch.draft_revision_id
    rev = await db.get(ChapterRevision, head) if head else None
    link = await db.scalar(select(AssetLink).where(AssetLink.target_type == "chapter", AssetLink.target_id == ch.id, AssetLink.purpose == "audio"))
    blocks = [{"bid": b["attrs"]["bid"], "text": cs.block_text(b)[:200]} for b in (rev.content_json.get("content", []) if rev else []) if cs.block_text(b).strip()]
    return {
        "chapter": {"id": ch.id, "title": ch.title, "work_id": ch.work_id},
        "audio_url": await signed_media_url(db, link.asset_id, ttl=3600) if link else None,
        "blocks": blocks,
        "marks": ch.audio_sync or [],
    }


@router.put("/studio/chapters/{chapter_id}/audio-sync")
async def put_audio_sync(chapter_id: int, body: SyncIn, db: DB, actor: CurActor):
    from app.services.audiosync import set_audio_sync

    ch = await _chapter(db, chapter_id)
    return {"marks": await set_audio_sync(db, actor, ch, [m.model_dump() for m in body.marks])}


# ------------------------------------------------------------ promo codes and referrals

class PromoRedeemIn(BaseModel):
    code: str = Field(max_length=40)


@router.post("/promo/redeem")
async def promo_redeem(body: PromoRedeemIn, db: DB, actor: CurActor):
    from app.services.growth import redeem_promo

    limiter.hit(f"promo:{actor.id}", 5, 300)  # codes cannot be brute-forced
    return await redeem_promo(db, actor.user, body.code)


@router.get("/me/referrals")
async def my_referrals(db: DB, actor: CurActor):
    from app.services.growth import referral_summary

    return await referral_summary(db, actor.user)


class PromoIn(BaseModel):
    code: str | None = Field(default=None, max_length=32)
    days: int
    max_uses: int | None = None
    valid_until: str | None = None
    new_users_only: bool = False
    note: str = Field(default="", max_length=500)


@router.get("/admin/promo-codes")
async def promo_list(db: DB, actor: CurActor):
    from app.models import PromoCode
    from app.services.growth import promo_dto

    actor.require("billing.view")
    rows = (await db.scalars(select(PromoCode).order_by(PromoCode.id.desc()).limit(200))).all()
    return {"items": [promo_dto(p) for p in rows]}


@router.post("/admin/promo-codes")
async def promo_create(body: PromoIn, db: DB, actor: CurActor):
    from datetime import datetime

    from app.services.growth import create_promo, promo_dto

    until = datetime.fromisoformat(body.valid_until.replace("Z", "+00:00")) if body.valid_until else None
    p = await create_promo(db, actor, code=body.code, days=body.days, max_uses=body.max_uses, valid_until=until, new_users_only=body.new_users_only, note=body.note)
    return promo_dto(p)


@router.delete("/admin/promo-codes/{promo_id}")
async def promo_deactivate(promo_id: int, db: DB, actor: CurActor):
    from app.services.growth import deactivate_promo

    await deactivate_promo(db, actor, promo_id)
    return {"ok": True}

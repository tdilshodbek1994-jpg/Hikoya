from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB, CurActor, Ents, OptActor, limiter
from app.core.errors import NotFound
from app.models import Chapter, Comment, User, Work
from app.services import social
from app.services.access import can_see_work_page

router = APIRouter(tags=["social"])


async def _work(db, actor, ent, work_id: int) -> Work:
    w = await db.get(Work, work_id)
    if w is None or not await can_see_work_page(db, w, actor.id if actor else None, ent):
        raise NotFound("Asar topilmadi")
    return w


@router.put("/works/{work_id}/like")
async def like(work_id: int, db: DB, actor: CurActor, ent: Ents):
    return await social.set_like(db, actor.user, await _work(db, actor, ent, work_id), True)


@router.delete("/works/{work_id}/like")
async def unlike(work_id: int, db: DB, actor: CurActor, ent: Ents):
    return await social.set_like(db, actor.user, await _work(db, actor, ent, work_id), False)


class ThanksIn(BaseModel):
    reason: str = ""


@router.put("/works/{work_id}/thanks")
async def thanks(work_id: int, db: DB, actor: CurActor, ent: Ents, body: ThanksIn | None = None):
    return await social.set_thanks(db, actor.user, await _work(db, actor, ent, work_id), True, (body.reason if body else ""))


@router.delete("/works/{work_id}/thanks")
async def unthanks(work_id: int, db: DB, actor: CurActor, ent: Ents):
    return await social.set_thanks(db, actor.user, await _work(db, actor, ent, work_id), False)


class FollowIn(BaseModel):
    notify_on_complete: bool | None = None


@router.put("/authors/{author_id}/follow")
async def follow_author(author_id: int, db: DB, actor: CurActor):
    return await social.set_follow(db, actor.user, "author", author_id, True)


@router.delete("/authors/{author_id}/follow")
async def unfollow_author(author_id: int, db: DB, actor: CurActor):
    return await social.set_follow(db, actor.user, "author", author_id, False)


@router.put("/works/{work_id}/follow")
async def follow_work(work_id: int, db: DB, actor: CurActor, ent: Ents, body: FollowIn | None = None):
    await _work(db, actor, ent, work_id)
    return await social.set_follow(db, actor.user, "work", work_id, True, body.notify_on_complete if body else None)


@router.delete("/works/{work_id}/follow")
async def unfollow_work(work_id: int, db: DB, actor: CurActor):
    return await social.set_follow(db, actor.user, "work", work_id, False)


@router.get("/works/{work_id}/comments")
async def comments(work_id: int, db: DB, actor: OptActor, ent: Ents, chapter_id: int | None = None, sort: str = "new", cursor: int = 0, block_id: str | None = None):
    w = await _work(db, actor, ent, work_id)
    return await social.list_comments(db, actor, ent, w, chapter_id=chapter_id, sort=sort, cursor=cursor, block_id=block_id)


@router.get("/works/{work_id}/chapters/{chapter_id}/inline-counts")
async def inline_counts(work_id: int, chapter_id: int, db: DB, actor: OptActor, ent: Ents):
    w = await _work(db, actor, ent, work_id)
    return {"counts": await social.inline_counts(db, ent, w, chapter_id)}


class CommentIn(BaseModel):
    body: str = Field(max_length=4000)
    chapter_id: int | None = None
    parent_id: int | None = None
    spoiler: bool = False
    client_key: str = Field(min_length=8, max_length=64)
    block_id: str = Field(default="", max_length=32)
    quote: str = Field(default="", max_length=1000)


@router.post("/works/{work_id}/comments")
async def post_comment(work_id: int, body: CommentIn, db: DB, actor: CurActor, ent: Ents):
    w = await _work(db, actor, ent, work_id)
    c = await social.create_comment(db, actor, ent, w, body.body, chapter_id=body.chapter_id, parent_id=body.parent_id, spoiler=body.spoiler, client_key=body.client_key, block_id=body.block_id, quote=body.quote)
    return social.comment_dto(c, actor.user.display_name, actor.id, True)


class CommentPatch(BaseModel):
    body: str = Field(max_length=4000)
    revision: int | None = None


async def _comment(db, cid: int) -> Comment:
    c = await db.get(Comment, cid)
    if c is None or c.status == "deleted":
        raise NotFound("Sharh topilmadi")
    return c


@router.patch("/comments/{cid}")
async def patch_comment(cid: int, body: CommentPatch, db: DB, actor: CurActor):
    c = await social.edit_comment(db, actor, await _comment(db, cid), body.body, body.revision)
    return social.comment_dto(c, actor.user.display_name, actor.id, True)


@router.delete("/comments/{cid}")
async def delete_comment(cid: int, db: DB, actor: CurActor):
    await social.delete_own_comment(db, actor, await _comment(db, cid))
    return {"ok": True}


@router.get("/comments/{cid}/reveal")
async def reveal(cid: int, db: DB, actor: OptActor, ent: Ents):
    """Explicit user action to open a spoiler. Paid chapter discussion still needs access."""
    c = await _comment(db, cid)
    if c.status != "published":
        raise NotFound()
    w = await _work(db, actor, ent, c.work_id)
    if c.chapter_id:
        from app.core.errors import AccessRequired
        from app.services.access import decide_chapter_access

        ch = await db.get(Chapter, c.chapter_id)
        if ch is None or not decide_chapter_access(w, ch, ent).full:
            raise AccessRequired("Bobga kirish kerak", code="access_required")
    name = await db.scalar(select(User.display_name).where(User.id == c.user_id))
    return social.comment_dto(c, name or "", actor.id if actor else None, True, reveal=True)


@router.put("/comments/{cid}/helpful")
async def helpful(cid: int, db: DB, actor: CurActor):
    return {"helpful": await social.vote_helpful(db, actor.user, await _comment(db, cid), True)}


@router.delete("/comments/{cid}/helpful")
async def unhelpful(cid: int, db: DB, actor: CurActor):
    return {"helpful": await social.vote_helpful(db, actor.user, await _comment(db, cid), False)}


@router.put("/comments/{cid}/pin")
async def pin(cid: int, db: DB, actor: CurActor):
    await social.pin_comment(db, actor, await _comment(db, cid), True)
    return {"pinned": True}


@router.delete("/comments/{cid}/pin")
async def unpin(cid: int, db: DB, actor: CurActor):
    await social.pin_comment(db, actor, await _comment(db, cid), False)
    return {"pinned": False}


class ReportIn(BaseModel):
    reason: str
    note: str = Field("", max_length=1000)


@router.post("/comments/{cid}/report")
async def report_comment(cid: int, body: ReportIn, db: DB, actor: CurActor):
    limiter.hit(f"report:{actor.id}", 20, 3600)
    await _comment(db, cid)
    r = await social.report(db, actor, "comment", cid, body.reason, body.note)
    return {"id": r.id, "status": r.status}


@router.post("/reports")
async def report_other(target_type: str, target_id: int, body: ReportIn, db: DB, actor: CurActor):
    limiter.hit(f"report:{actor.id}", 20, 3600)
    r = await social.report(db, actor, target_type, target_id, body.reason, body.note)
    return {"id": r.id, "status": r.status}

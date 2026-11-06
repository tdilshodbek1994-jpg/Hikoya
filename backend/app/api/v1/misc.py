from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import DB, CurActor, Ents, OptActor
from app.core.errors import NotFound
from app.models import Chapter, Work
from app.services import notify
from app.services.assets import asset_access, read_signed
from app.services.identity import can_edit_work

router = APIRouter(tags=["misc"])


@router.get("/notifications")
async def notifications(db: DB, actor: CurActor, before: int | None = None):
    return await notify.list_notifications(db, actor.id, before=before)


class ReadIn(BaseModel):
    ids: list[int] | None = None


@router.post("/notifications/read")
async def read(body: ReadIn, db: DB, actor: CurActor):
    await notify.mark_read(db, actor.id, body.ids)
    return {"ok": True}


@router.get("/assets/{asset_id}/access")
async def access(asset_id: int, db: DB, actor: OptActor, ent: Ents):
    async def staff_can_edit(links) -> bool:
        if not actor:
            return False
        for link in links:
            wid = None
            if link.target_type == "work":
                wid = link.target_id
            elif link.target_type == "chapter":
                ch = await db.get(Chapter, link.target_id)
                wid = ch.work_id if ch else None
            w = await db.get(Work, wid) if wid else None
            if w and await can_edit_work(db, actor, w):
                return True
        return False

    return await asset_access(db, asset_id, actor.id if actor else None, ent, staff_can_edit)


@router.get("/assets/file")
async def file(t: str, db: DB):
    """Short-lived signed link (default TTL 60 s). The token is not logged."""
    asset, data, download = await read_signed(db, t)
    headers = {"Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff"}
    if download:
        from urllib.parse import quote

        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(asset.original_name or 'fayl')}"
    else:
        headers["Content-Disposition"] = "inline"
    return Response(content=data, media_type=asset.mime, headers=headers)


@router.get("/links/resolve")
async def resolve(param: str, db: DB):
    """startapp parameter → target. A link never grants access by itself."""
    from app.services.content import get_work_by_code

    if param.startswith("w_"):
        w = await get_work_by_code(db, param[2:])
        if w:
            return {"type": "work", "code": w.short_code}
    elif param.startswith("c_") and param[2:].isdigit():
        ch = await db.get(Chapter, int(param[2:]))
        if ch:
            w = await db.get(Work, ch.work_id)
            return {"type": "chapter", "chapter_id": ch.id, "code": w.short_code if w else None}
    elif param.startswith("a_") and param[2:].isdigit():
        return {"type": "author", "author_id": int(param[2:])}
    elif param.startswith("st_") and param[3:].isdigit():
        return {"type": "story", "story_id": int(param[3:])}
    elif param.startswith("s_") and param[2:].isdigit():
        return {"type": "studio_work", "work_id": int(param[2:])}
    elif param.startswith("e_") and param[2:].isdigit():
        return {"type": "editor", "chapter_id": int(param[2:])}
    elif param in ("premium", "library", "notifications", "q_review", "q_moderation", "studio", "support"):
        return {"type": param}
    raise NotFound("Havola topilmadi")


__all__ = ["select"]

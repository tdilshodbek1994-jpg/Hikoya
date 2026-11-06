from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import DB, CurActor, Ents, OptActor
from app.core.errors import NotFound
from app.models import AuthorStory
from app.services import stories as svc

router = APIRouter(tags=["storis"])


@router.get("/storis/feed")
async def feed(db: DB, actor: OptActor):
    return await svc.feed(db, actor.user if actor else None)


@router.get("/storis/{story_id}")
async def get_story(story_id: int, db: DB, actor: OptActor, ent: Ents):
    is_owner = False
    if actor:
        s = await db.get(AuthorStory, story_id)
        is_owner = bool(s and (s.author_id in actor.author_ids or actor.has("story.moderate")))
    return await svc.get_story(db, story_id, actor.user if actor else None, ent, is_owner)


@router.get("/authors/{author_id}/storis")
async def author_storis(author_id: int, db: DB):
    return {"story_ids": await svc.author_stories(db, author_id)}


class ViewIn(BaseModel):
    frame_id: int
    dwell_ms: int = Field(ge=0, le=600000)
    completed: bool = False


@router.post("/storis/{story_id}/views")
async def view(story_id: int, body: ViewIn, db: DB, actor: CurActor):
    return {"counted": await svc.record_view(db, actor.user, body.frame_id, body.dwell_ms, body.completed)}


class ActionIn(BaseModel):
    frame_id: int
    action: str
    value: str = ""
    client_key: str = ""


@router.post("/storis/{story_id}/actions")
async def action(story_id: int, body: ActionIn, db: DB, actor: CurActor):
    await svc.record_action(db, actor.user, body.frame_id, body.action, body.value, body.client_key)
    res = {"ok": True}
    if body.action == "vote":
        res["results"] = await svc.poll_results(db, body.frame_id)  # type: ignore[assignment]
    return res


@router.get("/authors/{author_id}/highlights")
async def highlights(author_id: int, db: DB):
    from sqlalchemy import select

    from app.models import StoryHighlight

    rows = (await db.scalars(select(StoryHighlight).where(StoryHighlight.author_id == author_id).order_by(StoryHighlight.sort_key))).all()
    return [{"id": h.id, "title": h.title} for h in rows]


@router.get("/highlights/{highlight_id}")
async def highlight(highlight_id: int, db: DB, actor: OptActor, ent: Ents):
    from app.models import StoryHighlight

    h = await db.get(StoryHighlight, highlight_id)
    if h is None:
        raise NotFound()
    return await svc.highlight_frames(db, highlight_id, ent, bool(actor and h.author_id in actor.author_ids))


# --- author side (studio) ---


class FrameIn(BaseModel):
    kind: str = "text"
    text: str = Field("", max_length=700)
    media_asset_id: int | None = None
    background: str = "violet"
    subtitles: str = ""
    action_type: str = ""
    linked_work_id: int | None = None
    linked_chapter_id: int | None = None
    audience: str = "all"
    poll_options: list[str] = Field(default_factory=list)


class StoryIn(BaseModel):
    author_id: int | None = None
    caption: str = ""
    frames: list[FrameIn]
    duration_hours: int = 24
    publish_at: str | None = None
    audience: str = "all"
    submit: bool = True


@router.post("/studio/storis")
async def create_story(body: StoryIn, db: DB, actor: CurActor):
    from datetime import datetime

    publish_at = datetime.fromisoformat(body.publish_at.replace("Z", "+00:00")) if body.publish_at else None
    s = await svc.create_story(db, actor, author_id=body.author_id, caption=body.caption, frames=[f.model_dump() for f in body.frames], duration_hours=body.duration_hours, publish_at=publish_at, audience=body.audience, submit=body.submit)
    return {"id": s.id, "status": s.status, "publish_at": s.publish_at.isoformat() if s.publish_at else None, "expires_at": s.expires_at.isoformat() if s.expires_at else None}


@router.get("/studio/storis")
async def my_stories(db: DB, actor: CurActor, author_id: int | None = None):
    return await svc.my_stories(db, actor, author_id)


@router.post("/studio/storis/{story_id}/archive")
async def archive(story_id: int, db: DB, actor: CurActor):
    s = await db.get(AuthorStory, story_id)
    if s is None:
        raise NotFound()
    await svc.archive_story(db, actor, s)
    return {"ok": True}


@router.get("/studio/storis/analytics")
async def story_analytics(db: DB, actor: CurActor, author_id: int | None = None):
    return await svc.analytics(db, actor, author_id)


class HighlightIn(BaseModel):
    title: str
    frame_ids: list[int]
    author_id: int | None = None


@router.post("/studio/highlights")
async def add_highlight(body: HighlightIn, db: DB, actor: CurActor):
    h = await svc.add_highlight(db, actor, body.author_id, body.title, body.frame_ids)
    return {"id": h.id}

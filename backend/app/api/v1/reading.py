from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.api.deps import DB, CurActor, Ents, limiter
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.text import clean_plain
from app.models import (
    Bookmark,
    Chapter,
    ChapterRevision,
    ContentIssue,
    Dismissal,
    LibraryItem,
    PrivateNote,
    ReaderHighlight,
    ReadingProgress,
    UserCollection,
    UserCollectionItem,
    Work,
)
from app.services.access import can_see_work_page, decide_chapter_access
from app.services.catalog import CardBuilder
from app.services.reading import ingest_events, put_progress

router = APIRouter(tags=["reading"])


class ProgressIn(BaseModel):
    work_id: int
    chapter_id: int
    revision_id: int | None = None
    block_id: str = ""
    offset: float = 0
    ratio: float = 0
    sequence: int = 0
    device_id: str = Field("", max_length=64)
    client_ts: str | None = None
    force: bool = False


@router.put("/reading/progress")
async def save_progress(body: ProgressIn, db: DB, actor: CurActor, ent: Ents):
    chapter = await db.get(Chapter, body.chapter_id)
    work = await db.get(Work, body.work_id)
    if chapter is None or work is None or not await can_see_work_page(db, work, actor.id, ent):
        raise NotFound()
    return await put_progress(db, actor.user, body.model_dump())


class EventsIn(BaseModel):
    events: list[dict] = Field(default_factory=list, max_length=200)


@router.post("/reading/events/batch")
async def events_batch(body: EventsIn, db: DB, actor: CurActor):
    limiter.hit(f"events:{actor.id}", 120, 60)
    return await ingest_events(db, actor.user, body.events)


async def _cards(db, actor, ent, works):
    return await CardBuilder(db, actor.user, ent).build(works)


@router.get("/library")
async def library(db: DB, actor: CurActor, ent: Ents):
    """Continue, saved, reading, finished, purchased, quotes & notes, personal collections."""
    uid = actor.id
    prog_rows = (
        await db.execute(select(ReadingProgress, Work).join(Work, Work.id == ReadingProgress.work_id).where(ReadingProgress.user_id == uid).order_by(ReadingProgress.updated_at.desc()))
    ).all()
    reading = [w for p, w in prog_rows if p.completion_state != "completed"]
    finished = [w for p, w in prog_rows if p.completion_state == "completed"]
    saved = (await db.scalars(select(Work).join(LibraryItem, LibraryItem.work_id == Work.id).where(LibraryItem.user_id == uid).order_by(LibraryItem.added_at.desc()))).all()
    purchased = (await db.scalars(select(Work).where(Work.id.in_(ent.work_ids)))).all() if ent.work_ids else []
    highlights = (await db.scalars(select(ReaderHighlight).where(ReaderHighlight.user_id == uid).order_by(ReaderHighlight.created_at.desc()).limit(100))).all()
    notes = (await db.scalars(select(PrivateNote).where(PrivateNote.user_id == uid).order_by(PrivateNote.updated_at.desc()).limit(100))).all()
    bookmarks = (await db.scalars(select(Bookmark).where(Bookmark.user_id == uid).order_by(Bookmark.created_at.desc()).limit(100))).all()
    colls = (await db.scalars(select(UserCollection).where(UserCollection.user_id == uid).order_by(UserCollection.created_at))).all()
    counts = dict((await db.execute(select(UserCollectionItem.collection_id, func.count()).where(UserCollectionItem.collection_id.in_([c.id for c in colls] or [0])).group_by(UserCollectionItem.collection_id))).all())
    titles = {w.id: w.title for w in (await db.scalars(select(Work).where(Work.id.in_({h.work_id for h in highlights} | {n.work_id for n in notes} | {b.work_id for b in bookmarks} or {0})))).all()}
    return {
        "continue": (await _cards(db, actor, ent, reading[:3])),
        "reading": await _cards(db, actor, ent, reading),
        "saved": await _cards(db, actor, ent, list(saved)),
        "finished": await _cards(db, actor, ent, finished),
        "purchased": await _cards(db, actor, ent, list(purchased)),
        "highlights": [{"id": h.id, "work_id": h.work_id, "work_title": titles.get(h.work_id, ""), "chapter_id": h.chapter_id, "block_id": h.block_id, "quote": h.quote, "color": h.color} for h in highlights],
        "notes": [{"id": n.id, "work_id": n.work_id, "work_title": titles.get(n.work_id, ""), "chapter_id": n.chapter_id, "block_id": n.block_id, "quote": n.quote, "text": n.text} for n in notes],
        "bookmarks": [{"id": b.id, "work_id": b.work_id, "work_title": titles.get(b.work_id, ""), "chapter_id": b.chapter_id, "block_id": b.block_id, "quote": b.quote} for b in bookmarks],
        "collections": [{"id": c.id, "title": c.title, "is_private": c.is_private, "count": counts.get(c.id, 0)} for c in colls],
    }


async def _visible(db, actor, ent, work_id: int) -> Work:
    w = await db.get(Work, work_id)
    if w is None or not await can_see_work_page(db, w, actor.id, ent):
        raise NotFound("Asar topilmadi")
    return w


@router.put("/library/items/{work_id}")
async def add_library(work_id: int, db: DB, actor: CurActor, ent: Ents):
    await _visible(db, actor, ent, work_id)
    await db.execute(insert(LibraryItem).values(user_id=actor.id, work_id=work_id).on_conflict_do_nothing())
    return {"in_library": True}


@router.delete("/library/items/{work_id}")
async def remove_library(work_id: int, db: DB, actor: CurActor):
    await db.execute(delete(LibraryItem).where(LibraryItem.user_id == actor.id, LibraryItem.work_id == work_id))
    return {"in_library": False}


class AnchorIn(BaseModel):
    chapter_id: int
    revision_id: int | None = None
    block_id: str = Field(max_length=32)
    offset: float = 0
    quote: str = Field("", max_length=1000)


async def _check_anchor(db, actor, ent, a: AnchorIn) -> Chapter:
    ch = await db.get(Chapter, a.chapter_id)
    if ch is None:
        raise NotFound()
    w = await _visible(db, actor, ent, ch.work_id)
    if not decide_chapter_access(w, ch, ent).full and a.quote:
        # a quote from text the user cannot read is not stored
        rev = await db.get(ChapterRevision, ch.published_revision_id) if ch.published_revision_id else None
        allowed = set((rev.block_ids or [])[: ch.preview_blocks]) if rev else set()
        if a.block_id not in allowed:
            raise Forbidden("Bu matnga kirish yo'q", code="access_required")
    return ch


@router.post("/bookmarks")
async def add_bookmark(body: AnchorIn, db: DB, actor: CurActor, ent: Ents):
    ch = await _check_anchor(db, actor, ent, body)
    b = Bookmark(user_id=actor.id, work_id=ch.work_id, chapter_id=ch.id, revision_id=body.revision_id, block_id=body.block_id, offset=body.offset, quote=clean_plain(body.quote, 300))
    db.add(b)
    await db.flush()
    return {"id": b.id}


@router.delete("/bookmarks/{bid}")
async def del_bookmark(bid: int, db: DB, actor: CurActor):
    await db.execute(delete(Bookmark).where(Bookmark.id == bid, Bookmark.user_id == actor.id))
    return {"ok": True}


class HighlightIn(AnchorIn):
    start: int = 0
    end: int = 0
    color: str = "yellow"
    note: str = Field("", max_length=2000)


@router.post("/highlights")
async def add_highlight(body: HighlightIn, db: DB, actor: CurActor, ent: Ents):
    ch = await _check_anchor(db, actor, ent, body)
    quote = clean_plain(body.quote, 1000)
    if not quote:
        raise Invalid("Iqtibos bo'sh")
    h = ReaderHighlight(user_id=actor.id, work_id=ch.work_id, chapter_id=ch.id, revision_id=body.revision_id, block_id=body.block_id, start=body.start, end=body.end, quote=quote, color=body.color if body.color in ("yellow", "green", "blue", "pink") else "yellow")
    db.add(h)
    note_id = None
    if body.note.strip():
        n = PrivateNote(user_id=actor.id, work_id=ch.work_id, chapter_id=ch.id, revision_id=body.revision_id, block_id=body.block_id, quote=quote, text=clean_plain(body.note, 2000))
        db.add(n)
        await db.flush()
        note_id = n.id
    await db.flush()
    return {"id": h.id, "note_id": note_id}


@router.delete("/highlights/{hid}")
async def del_highlight(hid: int, db: DB, actor: CurActor):
    await db.execute(delete(ReaderHighlight).where(ReaderHighlight.id == hid, ReaderHighlight.user_id == actor.id))
    return {"ok": True}


@router.get("/chapters/{chapter_id}/my-marks")
async def my_marks(chapter_id: int, db: DB, actor: CurActor):
    hs = (await db.scalars(select(ReaderHighlight).where(ReaderHighlight.user_id == actor.id, ReaderHighlight.chapter_id == chapter_id))).all()
    bs = (await db.scalars(select(Bookmark).where(Bookmark.user_id == actor.id, Bookmark.chapter_id == chapter_id))).all()
    ns = (await db.scalars(select(PrivateNote).where(PrivateNote.user_id == actor.id, PrivateNote.chapter_id == chapter_id))).all()
    return {
        "highlights": [{"id": h.id, "block_id": h.block_id, "start": h.start, "end": h.end, "quote": h.quote, "color": h.color} for h in hs],
        "bookmarks": [{"id": b.id, "block_id": b.block_id} for b in bs],
        "notes": [{"id": n.id, "block_id": n.block_id, "text": n.text, "quote": n.quote} for n in ns],
    }


class NoteIn(BaseModel):
    work_id: int
    chapter_id: int | None = None
    block_id: str = Field("", max_length=32)
    quote: str = Field("", max_length=1000)
    text: str = Field(max_length=2000)


@router.post("/notes")
async def add_note(body: NoteIn, db: DB, actor: CurActor, ent: Ents):
    await _visible(db, actor, ent, body.work_id)
    n = PrivateNote(user_id=actor.id, work_id=body.work_id, chapter_id=body.chapter_id, block_id=body.block_id, quote=clean_plain(body.quote, 1000), text=clean_plain(body.text, 2000))
    db.add(n)
    await db.flush()
    return {"id": n.id}


class NotePatch(BaseModel):
    text: str = Field(max_length=2000)


@router.patch("/notes/{nid}")
async def patch_note(nid: int, body: NotePatch, db: DB, actor: CurActor):
    n = await db.get(PrivateNote, nid)
    if n is None or n.user_id != actor.id:
        raise NotFound()
    n.text = clean_plain(body.text, 2000)
    return {"ok": True}


@router.delete("/notes/{nid}")
async def del_note(nid: int, db: DB, actor: CurActor):
    await db.execute(delete(PrivateNote).where(PrivateNote.id == nid, PrivateNote.user_id == actor.id))
    return {"ok": True}


class CollectionIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)


@router.post("/collections")
async def create_collection(body: CollectionIn, db: DB, actor: CurActor):
    n = await db.scalar(select(func.count()).select_from(UserCollection).where(UserCollection.user_id == actor.id))
    if (n or 0) >= 50:
        raise Invalid("To'plamlar soni chegarasi 50", code="limit")
    c = UserCollection(user_id=actor.id, title=clean_plain(body.title, 80), is_private=True)
    db.add(c)
    await db.flush()
    return {"id": c.id, "title": c.title}


@router.get("/collections/{cid}")
async def get_collection(cid: int, db: DB, actor: CurActor, ent: Ents):
    c = await db.get(UserCollection, cid)
    if c is None or c.user_id != actor.id:
        raise NotFound()
    works = (await db.scalars(select(Work).join(UserCollectionItem, UserCollectionItem.work_id == Work.id).where(UserCollectionItem.collection_id == cid).order_by(UserCollectionItem.sort_key, UserCollectionItem.added_at))).all()
    return {"id": c.id, "title": c.title, "items": await _cards(db, actor, ent, list(works))}


@router.patch("/collections/{cid}")
async def rename_collection(cid: int, body: CollectionIn, db: DB, actor: CurActor):
    c = await db.get(UserCollection, cid)
    if c is None or c.user_id != actor.id:
        raise NotFound()
    c.title = clean_plain(body.title, 80)
    return {"ok": True}


@router.delete("/collections/{cid}")
async def delete_collection(cid: int, db: DB, actor: CurActor):
    await db.execute(delete(UserCollection).where(UserCollection.id == cid, UserCollection.user_id == actor.id))
    return {"ok": True}


@router.put("/collections/{cid}/items/{work_id}")
async def add_to_collection(cid: int, work_id: int, db: DB, actor: CurActor, ent: Ents):
    c = await db.get(UserCollection, cid)
    if c is None or c.user_id != actor.id:
        raise NotFound()
    await _visible(db, actor, ent, work_id)
    await db.execute(insert(UserCollectionItem).values(collection_id=cid, work_id=work_id).on_conflict_do_nothing())
    return {"ok": True}


@router.delete("/collections/{cid}/items/{work_id}")
async def remove_from_collection(cid: int, work_id: int, db: DB, actor: CurActor):
    c = await db.get(UserCollection, cid)
    if c is None or c.user_id != actor.id:
        raise NotFound()
    await db.execute(delete(UserCollectionItem).where(UserCollectionItem.collection_id == cid, UserCollectionItem.work_id == work_id))
    return {"ok": True}


class IssueIn(BaseModel):
    chapter_id: int
    revision_id: int
    block_id: str = Field(max_length=32)
    quote: str = Field("", max_length=500)
    note: str = Field("", max_length=1000)


@router.post("/content-issues")
async def report_issue(body: IssueIn, db: DB, actor: CurActor, ent: Ents):
    limiter.hit(f"issue:{actor.id}", 10, 3600)
    ch = await db.get(Chapter, body.chapter_id)
    if ch is None:
        raise NotFound()
    await _visible(db, actor, ent, ch.work_id)
    i = ContentIssue(user_id=actor.id, work_id=ch.work_id, chapter_id=ch.id, revision_id=body.revision_id, block_id=body.block_id, quote=clean_plain(body.quote, 500), note=clean_plain(body.note, 1000))
    db.add(i)
    await db.flush()
    return {"id": i.id}


class DismissIn(BaseModel):
    target_type: str
    target_id: int


@router.post("/recommendations/dismiss")
async def dismiss(body: DismissIn, db: DB, actor: CurActor):
    if body.target_type not in ("work", "genre", "tag"):
        raise Invalid()
    await db.execute(insert(Dismissal).values(user_id=actor.id, target_type=body.target_type, target_id=body.target_id).on_conflict_do_nothing())
    return {"ok": True}


@router.delete("/recommendations/dismiss")
async def undismiss(target_type: str, target_id: int, db: DB, actor: CurActor):
    await db.execute(delete(Dismissal).where(Dismissal.user_id == actor.id, Dismissal.target_type == target_type, Dismissal.target_id == target_id))
    return {"ok": True}

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import distinct, func, select

from app.api.deps import DB, CurActor, limiter
from app.core import content_schema as cs
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.text import minutes_for_words
from app.core.timeutil import utcnow
from app.models import (
    Asset,
    AssetLink,
    AuditLog,
    Chapter,
    ChapterCompletion,
    ChapterRevision,
    Comment,
    ContentIssue,
    EditorialReview,
    EditorNote,
    EntitlementGrant,
    Follow,
    ImportJob,
    PublishJob,
    QualifiedRead,
    ReadingProgress,
    StoryAction,
    StoryFrame,
    Thanks,
    Work,
    WorkContributor,
    WorkGenre,
    WorkTag,
)
from app.services import assets as asset_svc
from app.services import content as svc
from app.services import importer
from app.services.catalog import asset_urls
from app.services.identity import can_publish_work, can_review_work, require_edit_work

router = APIRouter(prefix="/studio", tags=["studio"])


def _require_studio(actor) -> None:
    if not (actor.has("work.create") or actor.has("work.edit_assigned") or actor.work_perms or actor.has("work.edit_any") or actor.has("work.review")):
        raise Forbidden("Ijod ustaxonasi uchun vakolat yo'q", code="permission_denied")


async def _work_dto(db, actor, w: Work, full: bool = False) -> dict:
    cover = (await asset_urls(db, {w.cover_asset_id} if w.cover_asset_id else set())).get(w.cover_asset_id or 0)
    d = {
        "id": w.id,
        "code": w.short_code,
        "title": w.title,
        "cover_url": cover,
        "cover_asset_id": w.cover_asset_id,
        "editorial_state": w.editorial_state,
        "completion_state": w.completion_state,
        "access_policy": w.access_policy,
        "requested_access": (w.content_flags or {}).get("requested_access"),
        "visibility": w.visibility,
        "format": w.format,
        "script": w.script,
        "chapters_published": w.chapters_published,
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
        "version": w.version,
        "is_demo": w.is_demo,
        "can_publish": await can_publish_work(db, actor, w),
        "can_review": await can_review_work(db, actor, w),
        "can_change_access": actor.has("work.change_access"),
    }
    if full:
        genres = (await db.execute(select(WorkGenre.genre_id, WorkGenre.is_primary).where(WorkGenre.work_id == w.id))).all()
        tags = (await db.scalars(select(WorkTag.tag_id).where(WorkTag.work_id == w.id))).all()
        chapters = await svc.list_chapters(db, w.id)
        jobs = {j.chapter_id: j for j in (await db.scalars(select(PublishJob).where(PublishJob.work_id == w.id, PublishJob.status.in_(("pending", "failed"))).order_by(PublishJob.id))).all()}
        files = (await db.execute(select(AssetLink, Asset).join(Asset, Asset.id == AssetLink.asset_id).where(AssetLink.target_type == "work", AssetLink.target_id == w.id))).all()
        reviews = (await db.scalars(select(EditorialReview).where(EditorialReview.work_id == w.id).order_by(EditorialReview.id.desc()).limit(20))).all()
        d.update(
            {
                "synopsis": w.synopsis,
                "primary_genre_id": w.primary_genre_id,
                "genre_ids": [g[0] for g in genres],
                "tag_ids": list(tags),
                "content_flags": w.content_flags,
                "comments_policy": w.comments_policy,
                "planned_chapters": w.planned_chapters,
                "next_release_at": w.next_release_at.isoformat() if w.next_release_at else None,
                "next_release_note": w.next_release_note,
                "recap_note": w.recap_note,
                "suspended_reason": w.suspended_reason,
                "chapters": [
                    {
                        "id": c.id,
                        "title": c.title,
                        "editorial_state": c.editorial_state,
                        "published_revision_id": c.published_revision_id,
                        "draft_revision_id": c.draft_revision_id,
                        "access_override": c.access_override,
                        "free_after_at": c.free_after_at.isoformat() if c.free_after_at else None,
                        "release_at": c.release_at.isoformat() if c.release_at else None,
                        "preview_blocks": c.preview_blocks,
                        "words": c.words,
                        "minutes": minutes_for_words(c.words),
                        "published_at": c.published_at.isoformat() if c.published_at else None,
                        "scheduled": ({"job_id": jobs[c.id].id, "run_at": jobs[c.id].run_at.isoformat(), "status": jobs[c.id].status, "error": jobs[c.id].last_error} if c.id in jobs else None),
                    }
                    for c in chapters
                ],
                "files": [{"link_id": link.id, "asset_id": a.id, "purpose": link.purpose, "title": link.title or a.original_name, "mime": a.mime, "size": a.size_bytes, "download_allowed": link.download_allowed} for link, a in files],
                "reviews": [{"id": r.id, "chapter_id": r.chapter_id, "decision": r.decision, "note": r.note, "created_at": r.created_at.isoformat()} for r in reviews],
            }
        )
    return d


@router.get("/works")
async def my_works(db: DB, actor: CurActor, scope: str = "mine", q: str = "", state: str | None = None):
    _require_studio(actor)
    query = select(Work)
    if scope == "all" and actor.has("work.edit_any"):
        pass
    elif scope == "assigned":
        query = query.where(Work.id.in_(list(actor.work_perms) or [0]))
    else:
        mine = select(WorkContributor.work_id).where(WorkContributor.author_id.in_(actor.author_ids or {0}))
        query = query.where((Work.primary_author_id.in_(actor.author_ids or {0})) | Work.id.in_(mine) | Work.id.in_(list(actor.work_perms) or [0]))
    if state:
        query = query.where(Work.editorial_state == state)
    if q.strip():
        from app.core.text import normalize_for_search

        nq = normalize_for_search(q)
        query = query.where(Work.search_text.ilike(f"%{nq}%") | (Work.short_code == q.strip()) | (Work.id == (int(q) if q.isdigit() else -1)))
    rows = (await db.scalars(query.order_by(Work.updated_at.desc()).limit(100))).all()
    return [await _work_dto(db, actor, w) for w in rows]


class WorkIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    synopsis: str = ""
    author_id: int | None = None
    format: str = "short"
    script: str = "latn"
    completion_state: str = "ongoing"
    primary_genre_id: int | None = None
    genre_ids: list[int] = Field(default_factory=list)
    tag_ids: list[int] = Field(default_factory=list)
    access_policy: str = "FREE"
    content_flags: dict = Field(default_factory=dict)
    copy_settings_from: int | None = None


@router.post("/works")
async def create_work(body: WorkIn, db: DB, actor: CurActor):
    data = body.model_dump()
    src_id = data.pop("copy_settings_from")
    if src_id:
        # copies classification only, never the text (spec 15)
        src = await svc.get_work(db, src_id)
        await require_edit_work(db, actor, src)
        data["format"] = data["format"] or src.format
        data["script"] = src.script
        data["primary_genre_id"] = data["primary_genre_id"] or src.primary_genre_id
    w = await svc.create_work(db, actor, **data)
    return await _work_dto(db, actor, w, full=True)


@router.get("/works/{work_id}")
async def get_work(work_id: int, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id)
    await require_edit_work(db, actor, w)
    return await _work_dto(db, actor, w, full=True)


@router.patch("/works/{work_id}")
async def patch_work(work_id: int, patch: dict, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id, for_update=True)
    version = patch.pop("version", None)
    for k in ("next_release_at",):
        if patch.get(k):
            patch[k] = datetime.fromisoformat(str(patch[k]).replace("Z", "+00:00"))
    w = await svc.update_work_meta(db, actor, w, patch, version)
    return await _work_dto(db, actor, w, full=True)


class AccessIn(BaseModel):
    access_policy: str
    reason: str = ""


@router.post("/works/{work_id}/access")
async def change_access(work_id: int, body: AccessIn, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id, for_update=True)
    await svc.change_access_policy(db, actor, w, body.access_policy, body.reason)
    return await _work_dto(db, actor, w, full=True)


class StateIn(BaseModel):
    action: str
    reason: str = ""


@router.post("/works/{work_id}/state")
async def change_state(work_id: int, body: StateIn, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id, for_update=True)
    await svc.set_work_state(db, actor, w, body.action, body.reason)
    return await _work_dto(db, actor, w, full=True)


@router.post("/works/{work_id}/delist")
async def delist(work_id: int, db: DB, actor: CurActor, body: StateIn | None = None):
    w = await svc.get_work(db, work_id, for_update=True)
    await svc.set_work_state(db, actor, w, "delist", body.reason if body else "")
    return await _work_dto(db, actor, w)


class ChapterIn(BaseModel):
    title: str = ""
    content: dict | None = None
    text: str | None = None
    access_override: str = "inherit"
    after_chapter_id: int | None = None
    copy_settings_from_chapter: int | None = None


@router.post("/works/{work_id}/chapters")
async def add_chapter(work_id: int, body: ChapterIn, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id)
    doc = body.content if body.content is not None else (cs.text_to_doc(body.text) if body.text else None)
    override = body.access_override
    if body.copy_settings_from_chapter:
        src = await svc.get_chapter(db, body.copy_settings_from_chapter)
        if src.work_id == w.id:
            override = src.access_override
    ch = await svc.add_chapter(db, actor, w, title=body.title, doc=doc, access_override=override, after_chapter_id=body.after_chapter_id)
    return {"id": ch.id, "title": ch.title, "draft_revision_id": ch.draft_revision_id}


class ReorderIn(BaseModel):
    chapter_ids: list[int]


@router.post("/works/{work_id}/chapters/reorder")
async def reorder(work_id: int, body: ReorderIn, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id)
    await svc.reorder_chapters(db, actor, w, body.chapter_ids)
    return {"ok": True}


@router.get("/chapters/{chapter_id}")
async def editor_chapter(chapter_id: int, db: DB, actor: CurActor):
    """Editor payload: the head (draft or published) revision with its id, for base_revision on save."""
    ch = await svc.get_chapter(db, chapter_id)
    w = await svc.get_work(db, ch.work_id)
    await require_edit_work(db, actor, w)
    head = ch.draft_revision_id or ch.published_revision_id
    rev = await db.get(ChapterRevision, head) if head else None
    notes = (await db.scalars(select(EditorNote).where(EditorNote.chapter_id == ch.id, EditorNote.resolved_at.is_(None)).order_by(EditorNote.id))).all()
    issues = (await db.scalars(select(ContentIssue).where(ContentIssue.chapter_id == ch.id, ContentIssue.status == "open").order_by(ContentIssue.id))).all()
    images = await asset_urls(db, set(cs.asset_ids(rev.content_json)) if rev else set())
    audio = (await db.execute(select(AssetLink, Asset).join(Asset, Asset.id == AssetLink.asset_id).where(AssetLink.target_type == "chapter", AssetLink.target_id == ch.id))).all()
    return {
        "work": {"id": w.id, "title": w.title, "code": w.short_code},
        "chapter": {"id": ch.id, "title": ch.title, "editorial_state": ch.editorial_state, "access_override": ch.access_override, "preview_blocks": ch.preview_blocks},
        "base_revision_id": head,
        "published_revision_id": ch.published_revision_id,
        "content": rev.content_json if rev else {"type": "doc", "content": []},
        "words": rev.word_count if rev else 0,
        "minutes": minutes_for_words(rev.word_count if rev else 0),
        "images": {str(k): v for k, v in images.items()},
        "attachments": [{"link_id": link.id, "asset_id": a.id, "purpose": link.purpose, "title": link.title or a.original_name, "mime": a.mime} for link, a in audio],
        "notes": [{"id": n.id, "block_id": n.block_id, "body": n.body, "author_user_id": n.author_user_id, "created_at": n.created_at.isoformat()} for n in notes],
        "issues": [{"id": i.id, "block_id": i.block_id, "quote": i.quote, "note": i.note, "revision_id": i.revision_id} for i in issues],
    }


class ChapterPatch(BaseModel):
    title: str | None = None
    access_override: str | None = None
    free_after_at: str | None = None
    release_at: str | None = None
    preview_blocks: int | None = None


@router.patch("/chapters/{chapter_id}")
async def patch_chapter(chapter_id: int, body: ChapterPatch, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, chapter_id, for_update=True)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    for k in ("free_after_at", "release_at"):
        if k in patch:
            patch[k] = datetime.fromisoformat(patch[k].replace("Z", "+00:00"))
    await svc.update_chapter_meta(db, actor, ch, patch)
    return {"ok": True}


@router.delete("/chapters/{chapter_id}")
async def delete_chapter(chapter_id: int, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, chapter_id, for_update=True)
    await svc.delete_chapter(db, actor, ch)
    return {"ok": True}


class RevisionIn(BaseModel):
    content: dict
    base_revision_id: int | None
    change_note: str = ""


@router.post("/chapters/{chapter_id}/revisions")
async def save_revision(chapter_id: int, body: RevisionIn, db: DB, actor: CurActor):
    """Autosave/save. A stale base_revision_id returns 409 with the current head (client keeps its text)."""
    limiter.hit(f"save:{actor.id}", 120, 60)
    ch = await svc.get_chapter(db, chapter_id)
    rev = await svc.save_revision(db, actor, ch, body.content, body.base_revision_id, body.change_note)
    return {"revision_id": rev.id, "words": rev.word_count, "minutes": minutes_for_words(rev.word_count), "saved_at": utcnow().isoformat(), "content": rev.content_json}


@router.get("/chapters/{chapter_id}/revisions")
async def revisions(chapter_id: int, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, chapter_id)
    revs = await svc.list_revisions(db, actor, ch)
    return [{"id": r.id, "parent_id": r.parent_revision_id, "created_at": r.created_at.isoformat(), "editor_id": r.editor_id, "note": r.change_note, "words": r.word_count, "published": r.id == ch.published_revision_id, "draft": r.id == ch.draft_revision_id} for r in revs]


@router.get("/revisions/{revision_id}")
async def get_revision(revision_id: int, db: DB, actor: CurActor):
    rev, ch, _ = await svc.get_revision_for_editor(db, actor, revision_id)
    return {"id": rev.id, "chapter_id": ch.id, "content": rev.content_json, "words": rev.word_count, "created_at": rev.created_at.isoformat()}


@router.get("/revisions/{revision_id}/diff")
async def diff(revision_id: int, db: DB, actor: CurActor, against: int | None = None):
    rev, ch, _ = await svc.get_revision_for_editor(db, actor, revision_id)
    base_id = against or rev.parent_revision_id or ch.published_revision_id
    base = None
    if base_id and base_id != rev.id:
        base, bch, _ = await svc.get_revision_for_editor(db, actor, base_id)
        if bch.id != ch.id:
            raise Invalid("Boshqa bob nusxasi", code="revision_mismatch")
    return {"revision_id": rev.id, "against": base.id if base else None, "changes": svc.diff_revisions(base, rev)}


class RestoreIn(BaseModel):
    revision_id: int
    publish: bool = False


@router.post("/chapters/{chapter_id}/restore")
async def restore(chapter_id: int, body: RestoreIn, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, chapter_id, for_update=True)
    rev = await svc.restore_revision(db, actor, ch, body.revision_id, body.publish)
    return {"revision_id": rev.id}


@router.get("/chapters/{chapter_id}/preview")
async def studio_preview(chapter_id: int, db: DB, actor: CurActor, revision_id: int | None = None):
    """Authorised preview (draft included). Never counted in statistics (T-26)."""
    ch = await svc.get_chapter(db, chapter_id)
    w = await svc.get_work(db, ch.work_id)
    await require_edit_work(db, actor, w)
    rid = revision_id or ch.draft_revision_id or ch.published_revision_id
    rev = await db.get(ChapterRevision, rid) if rid else None
    if rev is None or rev.chapter_id != ch.id:
        raise NotFound("Nusxa topilmadi")
    images = await asset_urls(db, set(cs.asset_ids(rev.content_json)))
    return {"work": {"id": w.id, "title": w.title, "code": w.short_code}, "chapter": {"id": ch.id, "title": ch.title}, "revision_id": rev.id, "mode": "full", "is_preview": True, "content": rev.content_json, "images": {str(k): v for k, v in images.items()}, "preview_blocks": ch.preview_blocks}


class SubmitIn(BaseModel):
    chapter_ids: list[int] | None = None
    note: str = ""


@router.post("/works/{work_id}/submit")
async def submit(work_id: int, body: SubmitIn, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id, for_update=True)
    reviews = await svc.submit_for_review(db, actor, w, body.chapter_ids, body.note)
    return {"reviews": [r.id for r in reviews], "editorial_state": w.editorial_state}


@router.get("/works/{work_id}/check")
async def check(work_id: int, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id)
    await require_edit_work(db, actor, w)
    chapters = [c for c in await svc.list_chapters(db, w.id)]
    return {"problems": await svc.technical_check(db, w, chapters)}


@router.get("/reviews")
async def review_queue(db: DB, actor: CurActor):
    if not (actor.has("work.review") or actor.has("work.publish") or actor.work_perms):
        raise Forbidden()
    q = select(EditorialReview, Work).join(Work, Work.id == EditorialReview.work_id).where(EditorialReview.decision == "pending")
    if not (actor.has("work.review") or actor.has("work.publish")):
        q = q.where(EditorialReview.work_id.in_(list(actor.work_perms)))
    rows = (await db.execute(q.order_by(EditorialReview.id))).all()
    out = []
    for r, w in rows:
        ch = await db.get(Chapter, r.chapter_id) if r.chapter_id else None
        out.append({"id": r.id, "work_id": w.id, "work_title": w.title, "chapter_id": r.chapter_id, "chapter_title": ch.title if ch else "", "revision_id": r.revision_id, "note": r.note, "created_at": r.created_at.isoformat(), "requested_access": (w.content_flags or {}).get("requested_access")})
    return out


class DecisionIn(BaseModel):
    decision: str
    note: str = ""


@router.post("/reviews/{review_id}")
async def decide(review_id: int, body: DecisionIn, db: DB, actor: CurActor):
    r = await db.get(EditorialReview, review_id)
    if r is None:
        raise NotFound()
    await svc.decide_review(db, actor, r, body.decision, body.note)
    return {"ok": True, "decision": r.decision}


class PublishIn(BaseModel):
    chapter_ids: list[int] | None = None


@router.post("/works/{work_id}/publish")
async def publish(work_id: int, body: PublishIn, db: DB, actor: CurActor):
    w = await svc.get_work(db, work_id, for_update=True)
    chs = await svc.publish_now(db, actor, w, body.chapter_ids)
    return {"published": [c.id for c in chs], "editorial_state": w.editorial_state, "url": f"w_{w.short_code}"}


class ScheduleIn(BaseModel):
    chapter_id: int
    run_at: str  # ISO 8601 with timezone, e.g. 2026-11-10T09:00:00+05:00


@router.post("/publish-jobs")
async def schedule(body: ScheduleIn, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, body.chapter_id, for_update=True)
    run_at = datetime.fromisoformat(body.run_at.replace("Z", "+00:00"))
    job = await svc.schedule_publish(db, actor, ch, run_at)
    return {"job_id": job.id, "run_at": job.run_at.isoformat(), "revision_id": job.revision_id, "job_version": job.job_version}


@router.delete("/publish-jobs/{chapter_id}")
async def unschedule(chapter_id: int, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, chapter_id, for_update=True)
    await svc.cancel_schedule(db, actor, ch)
    return {"ok": True}


@router.get("/calendar")
async def calendar(db: DB, actor: CurActor):
    _require_studio(actor)
    q = select(PublishJob, Work, Chapter).join(Work, Work.id == PublishJob.work_id).join(Chapter, Chapter.id == PublishJob.chapter_id).where(PublishJob.status.in_(("pending", "failed")))
    if not actor.has("work.edit_any"):
        q = q.where(Work.primary_author_id.in_(actor.author_ids or {0}) | Work.id.in_(list(actor.work_perms) or [0]))
    rows = (await db.execute(q.order_by(PublishJob.run_at))).all()
    return [{"job_id": j.id, "run_at": j.run_at.isoformat(), "status": j.status, "error": j.last_error, "work_id": w.id, "work_title": w.title, "chapter_id": c.id, "chapter_title": c.title} for j, w, c in rows]


# --- assets & import ---


@router.post("/assets/upload")
async def upload(db: DB, actor: CurActor, file: UploadFile = File(...), purpose: str = Form("attachment"), public: bool = Form(False)):
    _require_studio(actor)
    limiter.hit(f"upload:{actor.id}", 30, 600)
    data = await file.read(asset_svc.MIB * 101)
    asset = await asset_svc.store_upload(db, actor.id, data, file.filename or "", source="app", public=public and purpose in ("cover", "image", "avatar"))
    url = await asset_svc.signed_media_url(db, asset.id)
    return {"asset_id": asset.id, "kind": asset.kind, "mime": asset.mime, "size": asset.size_bytes, "checksum": asset.checksum, "url": url, "visibility": asset.visibility, "state": asset.processing_state}


class LinkIn(BaseModel):
    asset_id: int
    target_type: str
    target_id: int
    purpose: str
    title: str = ""
    download_allowed: bool = False


@router.post("/assets/link")
async def link(body: LinkIn, db: DB, actor: CurActor):
    asset = await db.get(Asset, body.asset_id)
    if asset is None or (asset.owner_id != actor.id and not actor.has("work.edit_any")):
        raise NotFound("Fayl topilmadi")
    if body.target_type == "work":
        w = await svc.get_work(db, body.target_id)
    elif body.target_type == "chapter":
        w = await svc.get_work(db, (await svc.get_chapter(db, body.target_id)).work_id)
    else:
        raise Invalid()
    await require_edit_work(db, actor, w)
    if body.purpose == "cover":
        await asset_svc.make_public(db, asset)
        w.cover_asset_id = asset.id
        return {"ok": True, "cover_asset_id": asset.id}
    lnk = await asset_svc.link_asset(db, asset, body.target_type, body.target_id, body.purpose, title=body.title, download_allowed=body.download_allowed)
    await svc.recompute_work_counters(db, w)
    return {"link_id": lnk.id}


@router.delete("/assets/link/{link_id}")
async def unlink(link_id: int, db: DB, actor: CurActor):
    lnk = await db.get(AssetLink, link_id)
    if lnk is None:
        raise NotFound()
    wid = lnk.target_id if lnk.target_type == "work" else (await svc.get_chapter(db, lnk.target_id)).work_id
    w = await svc.get_work(db, wid)
    await require_edit_work(db, actor, w)
    await db.delete(lnk)
    return {"ok": True}


class ImportIn(BaseModel):
    asset_id: int
    work_id: int
    allow_duplicate: bool = False


@router.post("/imports")
async def start_import(body: ImportIn, db: DB, actor: CurActor):
    asset = await db.get(Asset, body.asset_id)
    if asset is None:
        raise NotFound("Fayl topilmadi")
    job = await importer.start_import(db, actor, asset, body.work_id, allow_duplicate=body.allow_duplicate)
    return _import_dto(job)


def _import_dto(job: ImportJob) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "report": job.report,
        "chapters": [{"index": i, "title": c["title"], "words": c["words"], "preview": cs.plain_text(c["content"])[:400]} for i, c in enumerate(job.proposed)],
        "created_chapters": job.created_chapters,
    }


@router.get("/imports/{import_id}")
async def get_import(import_id: int, db: DB, actor: CurActor):
    job = await db.get(ImportJob, import_id)
    if job is None or (job.owner_id != actor.id and not actor.has("work.edit_any")):
        raise NotFound()
    return _import_dto(job)


class ApplyIn(BaseModel):
    selected: list[int] | None = None
    titles: dict[int, str] = Field(default_factory=dict)


@router.post("/imports/{import_id}/apply")
async def apply_import(import_id: int, body: ApplyIn, db: DB, actor: CurActor):
    job = await db.get(ImportJob, import_id)
    if job is None:
        raise NotFound()
    created = await importer.apply_import(db, actor, job, body.selected, body.titles)
    return {"created_chapters": created}


# --- notes from editor / author ---


class NoteIn(BaseModel):
    block_id: str = ""
    body: str = Field(min_length=1, max_length=2000)


@router.post("/chapters/{chapter_id}/notes")
async def add_note(chapter_id: int, body: NoteIn, db: DB, actor: CurActor):
    ch = await svc.get_chapter(db, chapter_id)
    w = await svc.get_work(db, ch.work_id)
    await require_edit_work(db, actor, w)
    n = EditorNote(chapter_id=ch.id, revision_id=ch.draft_revision_id or ch.published_revision_id, block_id=body.block_id[:32], author_user_id=actor.id, body=body.body)
    db.add(n)
    await db.flush()
    return {"id": n.id}


@router.post("/notes/{note_id}/resolve")
async def resolve_note(note_id: int, db: DB, actor: CurActor):
    n = await db.get(EditorNote, note_id)
    if n is None:
        raise NotFound()
    ch = await svc.get_chapter(db, n.chapter_id)
    await require_edit_work(db, actor, await svc.get_work(db, ch.work_id))
    n.resolved_at = utcnow()
    return {"ok": True}


@router.post("/issues/{issue_id}")
async def resolve_issue(issue_id: int, status: str, db: DB, actor: CurActor):
    i = await db.get(ContentIssue, issue_id)
    if i is None or status not in ("accepted", "rejected"):
        raise NotFound()
    await require_edit_work(db, actor, await svc.get_work(db, i.work_id))
    i.status = status
    return {"ok": True}


# --- author dashboard & analytics ---


@router.get("/dashboard")
async def dashboard(db: DB, actor: CurActor):
    _require_studio(actor)
    mine = select(Work.id).where(Work.primary_author_id.in_(actor.author_ids or {0}))
    drafts = (await db.scalars(select(Work).where(Work.id.in_(mine), Work.editorial_state.in_(("draft", "changes_requested"))).order_by(Work.updated_at.desc()).limit(20))).all()
    half_chapters = (
        await db.execute(
            select(Chapter, Work.title).join(Work, Work.id == Chapter.work_id).where(Chapter.work_id.in_(mine), Chapter.draft_revision_id.is_not(None), Chapter.is_deleted.is_(False)).order_by(Chapter.updated_at.desc()).limit(20)
        )
    ).all()
    reviews = (await db.scalars(select(EditorialReview).where(EditorialReview.work_id.in_(mine), EditorialReview.decision != "pending").order_by(EditorialReview.decided_at.desc()).limit(10))).all()
    jobs = (await db.execute(select(PublishJob, Chapter.title).join(Chapter, Chapter.id == PublishJob.chapter_id).where(PublishJob.work_id.in_(mine), PublishJob.status.in_(("pending", "failed"))).order_by(PublishJob.run_at))).all()
    unanswered = (
        await db.scalars(
            select(Comment).where(Comment.work_id.in_(mine), Comment.status == "published", Comment.parent_id.is_(None), Comment.is_author_reply.is_(False), ~Comment.id.in_(select(Comment.parent_id).where(Comment.parent_id.is_not(None), Comment.is_author_reply.is_(True)))).order_by(Comment.id.desc()).limit(20)
        )
    ).all()
    thanks = (await db.execute(select(Thanks.reason, func.count()).where(Thanks.work_id.in_(mine), Thanks.active.is_(True)).group_by(Thanks.reason))).all()
    from app.services.stories import my_stories

    stories = await my_stories(db, actor, None) if actor.own_author_id else []
    return {
        "drafts": [{"id": w.id, "title": w.title, "state": w.editorial_state} for w in drafts],
        "draft_chapters": [{"id": c.id, "title": c.title, "work_title": t} for c, t in half_chapters],
        "review_answers": [{"id": r.id, "work_id": r.work_id, "decision": r.decision, "note": r.note} for r in reviews],
        "scheduled": [{"job_id": j.id, "run_at": j.run_at.isoformat(), "status": j.status, "chapter_title": t} for j, t in jobs],
        "story_plans": [s for s in stories if s["status"] in ("draft", "pending")][:10],
        "unanswered_comments": [{"id": c.id, "work_id": c.work_id, "body": c.body[:200]} for c in unanswered],
        "thanks_by_reason": {r or "none": n for r, n in thanks},
        "income_note": "Daromad hisoboti keyingi bosqichda. «Rahmat» moliyaviy balans emas.",
    }


@router.get("/works/{work_id}/stats")
async def work_stats(work_id: int, db: DB, actor: CurActor):
    """Aggregated per-work statistics for its author. No individual reader data (spec 21)."""
    w = await svc.get_work(db, work_id)
    await require_edit_work(db, actor, w)
    unique = await db.scalar(select(func.count(distinct(QualifiedRead.user_id))).where(QualifiedRead.work_id == w.id)) or 0
    started = await db.scalar(select(func.count()).select_from(ReadingProgress).where(ReadingProgress.work_id == w.id)) or 0
    finished = await db.scalar(select(func.count()).select_from(ReadingProgress).where(ReadingProgress.work_id == w.id, ReadingProgress.completion_state == "completed")) or 0
    followers = await db.scalar(select(func.count()).select_from(Follow).where(Follow.target_type == "work", Follow.target_id == w.id)) or 0
    chapters = await svc.list_chapters(db, w.id)
    per_ch = dict((await db.execute(select(ChapterCompletion.chapter_id, func.count()).where(ChapterCompletion.work_id == w.id).group_by(ChapterCompletion.chapter_id))).all())
    story_frames = select(StoryFrame.id).where(StoryFrame.linked_work_id == w.id)
    from_story = await db.scalar(select(func.count(distinct(StoryAction.user_id))).where(StoryAction.action.in_(("start_work", "link_click")), StoryAction.frame_id.in_(story_frames))) or 0
    purchases = await db.scalar(select(func.count()).select_from(EntitlementGrant).where(EntitlementGrant.scope_type == "work", EntitlementGrant.scope_id == w.id, EntitlementGrant.revoked_at.is_(None))) or 0
    small = unique < 5
    funnel = []
    prev = started
    for c in chapters:
        if not c.published_revision_id:
            continue
        n = per_ch.get(c.id, 0)
        funnel.append({"chapter_id": c.id, "title": c.title, "completed": None if small else n, "next_transition": None if small or not prev else round(n / prev, 2)})
        prev = n or prev
    return {
        "unique_qualified_readers": unique,
        "started": started,
        "finished": finished,
        "start_to_finish": round(finished / started, 2) if started and not small else None,
        "likes": w.likes_count,
        "thanks": w.thanks_count,
        "comments": w.comments_count,
        "followers": followers,
        "reads_from_storis": None if small else from_story,
        "work_purchases": purchases if actor.has("billing.view") or not small else None,
        "chapters": funnel,
        "small_sample": small,
        "note": "Turli hajmdagi asarlar natijasi «sifat bahosi» emas. Kam namunada nozik kesimlar ko'rsatilmaydi.",
    }


@router.get("/works/{work_id}/stats.csv")
async def work_stats_csv(work_id: int, db: DB, actor: CurActor):
    """T-58: export of the author's own aggregated numbers only (no reader ids, notes or purchases)."""
    import csv
    import io

    from fastapi.responses import Response

    data = await work_stats(work_id, db, actor)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["metric", "value"])
    for k in ("unique_qualified_readers", "started", "finished", "start_to_finish", "likes", "thanks", "comments", "followers", "reads_from_storis"):
        w.writerow([k, "" if data[k] is None else data[k]])
    w.writerow([])
    w.writerow(["chapter_id", "chapter_title", "completed", "next_transition"])
    for c in data["chapters"]:
        w.writerow([c["chapter_id"], c["title"], "" if c["completed"] is None else c["completed"], "" if c["next_transition"] is None else c["next_transition"]])
    w.writerow([])
    w.writerow(["note", data["note"]])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="work-{work_id}-stats.csv"'})


@router.get("/audit")
async def audit_log(db: DB, actor: CurActor, target_type: str | None = None, target_id: str | None = None, limit: int = 100):
    if not actor.has("audit.view"):
        # authors see the audit of their own works only
        if target_type != "work" or not target_id:
            raise Forbidden()
        await require_edit_work(db, actor, await svc.get_work(db, int(target_id)))
    q = select(AuditLog)
    if target_type:
        q = q.where(AuditLog.target_type == target_type)
    if target_id:
        q = q.where(AuditLog.target_id == target_id)
    rows = (await db.scalars(q.order_by(AuditLog.id.desc()).limit(min(limit, 500)))).all()
    return [{"id": a.id, "actor_user_id": a.actor_user_id, "on_behalf_of_author_id": a.on_behalf_of_author_id, "action": a.action, "target": f"{a.target_type}:{a.target_id}", "reason": a.reason, "before": a.before, "after": a.after, "at": a.created_at.isoformat(), "request_id": a.request_id} for a in rows]


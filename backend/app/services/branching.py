"""Branching stories: choices at the end of a chapter lead to other chapters of the same work.

* the author defines up to 4 choices per chapter (label + target chapter);
* a reader sees only choices whose target is published; locked targets are marked, never opened;
* the latest pick per chapter is stored (it can be changed); totals are shown as percentages
  only after the reader has chosen, so the crowd does not steer the first decision.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid, NotFound
from app.core.text import clean_plain
from app.core.timeutil import utcnow
from app.models import Chapter, ChapterChoice, ReaderChoice, User, Work
from app.services.access import Entitlements, decide_chapter_access
from app.services.identity import Actor, audit, require_edit_work

MAX_CHOICES = 4


async def work_is_branching(db: AsyncSession, work_id: int) -> bool:
    return bool(await db.scalar(select(ChapterChoice.id).join(Chapter, Chapter.id == ChapterChoice.chapter_id).where(Chapter.work_id == work_id).limit(1)))


async def set_choices(db: AsyncSession, actor: Actor, chapter: Chapter, items: list[dict]) -> list[ChapterChoice]:
    """Replace the chapter's choices. Existing ones with the same target keep their id (and reader picks)."""
    work = await db.get(Work, chapter.work_id)
    assert work is not None
    await require_edit_work(db, actor, work)
    if len(items) > MAX_CHOICES:
        raise Invalid(f"Ko'pi bilan {MAX_CHOICES} ta tanlov", code="too_many_choices")
    clean: list[tuple[str, int]] = []
    seen: set[int] = set()
    for it in items:
        label = clean_plain(str(it.get("label", "")), 120)
        target = int(it.get("target_chapter_id") or 0)
        if not label:
            raise Invalid("Tanlov matni kerak", code="label_required")
        if target == chapter.id or target in seen:
            raise Invalid("Tanlov o'sha bobga yoki ikki marta bir bobga olib bormasin", code="target_invalid")
        t = await db.get(Chapter, target)
        if t is None or t.work_id != chapter.work_id or t.is_deleted:
            raise Invalid("Tanlov shu asardagi bobga olib borishi kerak", code="target_invalid")
        seen.add(target)
        clean.append((label, target))
    existing = {c.target_chapter_id: c for c in (await db.scalars(select(ChapterChoice).where(ChapterChoice.chapter_id == chapter.id))).all()}
    out = []
    for i, (label, target) in enumerate(clean):
        c = existing.pop(target, None) or ChapterChoice(chapter_id=chapter.id, target_chapter_id=target, label=label)
        c.label, c.sort_order = label, i
        db.add(c)
        out.append(c)
    for c in existing.values():
        await db.delete(c)
    await db.flush()
    await audit(db, actor, "chapter.choices", "chapter", chapter.id, after={"choices": [{"label": lb, "target": t} for lb, t in clean]})
    return out


async def studio_choices(db: AsyncSession, actor: Actor, chapter: Chapter) -> list[dict]:
    work = await db.get(Work, chapter.work_id)
    assert work is not None
    await require_edit_work(db, actor, work)
    rows = (await db.scalars(select(ChapterChoice).where(ChapterChoice.chapter_id == chapter.id).order_by(ChapterChoice.sort_order))).all()
    counts = await _counts(db, [c.id for c in rows])
    return [{"id": c.id, "label": c.label, "target_chapter_id": c.target_chapter_id, "picks": counts.get(c.id, 0)} for c in rows]


async def _counts(db: AsyncSession, ids: list[int]) -> dict[int, int]:
    if not ids:
        return {}
    return {cid: n for cid, n in (await db.execute(select(ReaderChoice.choice_id, func.count()).where(ReaderChoice.choice_id.in_(ids)).group_by(ReaderChoice.choice_id))).all()}


async def reader_choices(db: AsyncSession, user: User | None, work: Work, chapter: Chapter, ent: Entitlements) -> list[dict] | None:
    """Choices for the end of the chapter (None when the chapter is linear)."""
    rows = (await db.execute(
        select(ChapterChoice, Chapter)
        .join(Chapter, Chapter.id == ChapterChoice.target_chapter_id)
        .where(ChapterChoice.chapter_id == chapter.id, Chapter.is_deleted.is_(False), Chapter.published_revision_id.is_not(None), Chapter.published_at <= utcnow())
        .order_by(ChapterChoice.sort_order)
    )).all()
    if not rows:
        return None
    mine = await db.get(ReaderChoice, (user.id, chapter.id)) if user else None
    counts = await _counts(db, [c.id for c, _ in rows]) if mine else {}
    total = sum(counts.values())
    return [
        {
            "id": c.id,
            "label": c.label,
            "target_chapter_id": t.id,
            "locked": not decide_chapter_access(work, t, ent).full,
            "chosen": bool(mine and mine.choice_id == c.id),
            # shown only after the reader has decided
            "percent": round(100 * counts.get(c.id, 0) / total) if mine and total else None,
        }
        for c, t in rows
    ]


async def choose(db: AsyncSession, user: User, ent: Entitlements, chapter_id: int, choice_id: int) -> dict:
    c = await db.get(ChapterChoice, choice_id)
    if c is None or c.chapter_id != chapter_id:
        raise NotFound("Tanlov topilmadi")
    ch = await db.get(Chapter, chapter_id)
    work = await db.get(Work, ch.work_id) if ch else None
    if ch is None or work is None or not decide_chapter_access(work, ch, ent).full:
        # you choose at the end of a chapter you can read
        raise NotFound("Bob topilmadi")
    await db.execute(
        insert(ReaderChoice)
        .values(user_id=user.id, chapter_id=chapter_id, choice_id=choice_id)
        .on_conflict_do_update(index_elements=["user_id", "chapter_id"], set_={"choice_id": choice_id, "created_at": utcnow()})
    )
    target = await db.get(Chapter, c.target_chapter_id)
    return {"target_chapter_id": c.target_chapter_id, "locked": not decide_chapter_access(work, target, ent).full if target else True}

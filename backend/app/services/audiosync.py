"""Block-level audio ↔ text sync («audio bilan birga o'qish»).

The author listens to the chapter audio and taps each paragraph when its narration starts.
Stored as ``chapters.audio_sync = [{"bid": ..., "t": seconds}, ...]``. The reader highlights
the paragraph being narrated and can tap a paragraph to jump the audio there.
Word-level alignment needs a speech model and is not done here.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Invalid
from app.models import Chapter, ChapterRevision, Work
from app.services.identity import Actor, audit, require_edit_work

MAX_SECONDS = 6 * 3600


async def set_audio_sync(db: AsyncSession, actor: Actor, chapter: Chapter, marks: list[dict]) -> list[dict]:
    work = await db.get(Work, chapter.work_id)
    assert work is not None
    await require_edit_work(db, actor, work)
    head = chapter.published_revision_id or chapter.draft_revision_id
    rev = await db.get(ChapterRevision, head) if head else None
    if rev is None:
        raise Invalid("Bobda matn yo'q", code="no_text")
    order = {bid: i for i, bid in enumerate(rev.block_ids or [])}
    clean: dict[str, float] = {}
    for m in marks:
        bid, t = str(m.get("bid", "")), m.get("t")
        if bid not in order:
            raise Invalid("Matn bloki topilmadi (bob o'zgargan bo'lishi mumkin)", code="block_not_found")
        try:
            t = round(float(t), 2)
        except (TypeError, ValueError) as e:
            raise Invalid("Vaqt noto'g'ri", code="time_invalid") from e
        if not 0 <= t <= MAX_SECONDS:
            raise Invalid("Vaqt noto'g'ri", code="time_invalid")
        clean[bid] = t
    out = sorted(({"bid": b, "t": t} for b, t in clean.items()), key=lambda m: (m["t"], order[m["bid"]]))
    # narration follows the text: a later paragraph cannot start before an earlier one
    for a, b in zip(out, out[1:]):
        if order[b["bid"]] < order[a["bid"]]:
            raise Invalid("Vaqtlar matn tartibiga mos emas: keyingi xatboshi oldingisidan oldin boshlanmaydi", code="sync_order")
    chapter.audio_sync = out
    await audit(db, actor, "chapter.audio_sync", "chapter", chapter.id, after={"marks": len(out)})
    return out

"""Text import: file → type/size check → safe parser → chapter guess → user review → draft (spec 17.3).

Imports never execute macros or code and never touch the published text.
"""

from __future__ import annotations

import io
import re
import zipfile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import content_schema as cs
from app.core.errors import Invalid, NotFound
from app.core.text import clean_plain, word_count
from app.models import Asset, ImportJob, Work
from app.services.content import add_chapter, get_work
from app.services.identity import Actor, audit, require_edit_work

PARSER_VERSION = "1"
MAX_DOCX_UNCOMPRESSED = 60 * 1024 * 1024
MAX_DOCX_ENTRIES = 2000
CHAPTER_RE = re.compile(
    r"^\s*(?:(\d{1,3})\s*[-–.]?\s*(?:bob|qism|qisim|fasl)|(?:bob|qism|fasl|глава|боб|қисм)\s*(\d{1,3})|(?:[IVXLC]{1,6})\.?)\s*[:.\-–]?\s*(.{0,80})$",
    re.I,
)


def check_docx_container(data: bytes) -> None:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise Invalid("DOCX fayli buzilgan", code="docx_invalid") from e
    infos = z.infolist()
    if len(infos) > MAX_DOCX_ENTRIES or sum(i.file_size for i in infos) > MAX_DOCX_UNCOMPRESSED:
        raise Invalid("DOCX ichidagi hajm juda katta", code="docx_too_large")
    if "word/document.xml" not in z.namelist():
        raise Invalid("Bu DOCX hujjat emas", code="docx_invalid")
    if any(n.lower().endswith(("vbaproject.bin",)) for n in z.namelist()):
        # macros are ignored entirely; we only read paragraph text
        pass


def _split_chapters(blocks: list[tuple[str, str]], warnings: list[str]) -> list[dict]:
    """blocks: (kind, text) where kind is 'heading' | 'para'. Returns proposed chapters."""
    chapters: list[dict] = []
    current: dict | None = None
    for kind, text in blocks:
        is_heading = kind == "heading" or (len(text) < 90 and CHAPTER_RE.match(text) is not None)
        if is_heading:
            current = {"title": text.strip()[:200], "paras": []}
            chapters.append(current)
            continue
        if current is None:
            current = {"title": "", "paras": []}
            chapters.append(current)
        current["paras"].append(text)
    out = []
    for i, ch in enumerate(chapters):
        if not ch["paras"]:
            if ch["title"]:
                warnings.append(f"«{ch['title']}» sarlavhasidan keyin matn yo'q")
            continue
        text = "\n\n".join(ch["paras"])
        doc = cs.text_to_doc(text, markdown=True)
        out.append({"title": ch["title"] or f"{len(out) + 1}-bob", "content": doc, "words": word_count(text)})
    return out


def decode_text(data: bytes, warnings: list[str]) -> str:
    """UTF-8 first; a mostly-undecodable file is retried as Windows-1251 (common for Cyrillic texts)."""
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    raw = data.decode("utf-8", errors="replace")
    bad = raw.count("\ufffd")
    if bad and bad > max(3, len(raw) // 50):
        try:
            alt = data.decode("cp1251")
        except UnicodeDecodeError:
            alt = ""
        # only a real Cyrillic text is accepted as cp1251; random damage stays UTF-8 with a warning
        cyr = sum(1 for ch in alt if "\u0400" <= ch <= "\u04ff")
        if alt and cyr >= 20 and cyr >= 0.6 * sum(1 for ch in alt if ord(ch) > 127):
            warnings.append("Fayl Windows-1251 kodlashida deb o'qildi. Matnni tekshirib chiqing.")
            return alt
    if bad:
        warnings.append(f"{bad} ta belgi tanilmadi (buzilgan joy yoki boshqa kodlash), ular belgi bilan almashtirildi.")
    return raw


def parse_text(data: bytes, markdown: bool) -> tuple[list[dict], dict]:
    warnings: list[str] = []
    raw = decode_text(data, warnings)
    raw = clean_plain(raw)
    blocks: list[tuple[str, str]] = []
    for para in re.split(r"\n\s*\n", raw):
        p = para.strip()
        if not p:
            continue
        if markdown and p.startswith("# "):
            blocks.append(("heading", p[2:].strip()))
        else:
            blocks.append(("para", p))
    chapters = _split_chapters(blocks, warnings)
    return chapters, {"warnings": warnings, "lost_formatting": []}


def parse_docx(data: bytes) -> tuple[list[dict], dict]:
    check_docx_container(data)
    import docx  # python-docx: reads XML only, never runs macros

    warnings: list[str] = []
    lost: set[str] = set()
    try:
        d = docx.Document(io.BytesIO(data))
    except Exception as e:  # corrupt XML parts
        raise Invalid("DOCX faylini o'qib bo'lmadi", code="docx_invalid") from e
    blocks: list[tuple[str, str]] = []
    if d.tables:
        lost.add("jadvallar")
    if d.inline_shapes:
        lost.add("rasmlar (alohida yuklang)")
    for p in d.paragraphs:
        text = clean_plain(p.text)
        if not text:
            continue
        style = (p.style.name or "").lower() if p.style is not None else ""
        if style.startswith("heading") or style.startswith("title") or style.startswith("заголовок"):
            blocks.append(("heading", text))
        else:
            parts = []
            for r in p.runs:
                t = r.text
                if not t:
                    continue
                if r.bold and t.strip():
                    t = f"**{t}**"
                elif r.italic and t.strip():
                    t = f"*{t}*"
                if r.underline:
                    lost.add("tagiga chizish")
                parts.append(t)
            blocks.append(("para", clean_plain("".join(parts)) or text))
    chapters = _split_chapters(blocks, warnings)
    return chapters, {"warnings": warnings, "lost_formatting": sorted(lost)}


async def start_import(db: AsyncSession, actor: Actor, asset: Asset, work_id: int, *, allow_duplicate: bool = False) -> ImportJob:
    work = await get_work(db, work_id)
    await require_edit_work(db, actor, work)
    if asset.owner_id != actor.id and not actor.has("work.edit_any"):
        raise NotFound("Fayl topilmadi")
    if asset.kind not in ("text", "docx"):
        raise Invalid("Matnga aylantirish faqat TXT, Markdown va DOCX uchun. PDF faqat biriktirma bo'ladi.", code="not_convertible")
    existing = await db.scalar(
        select(ImportJob).where(ImportJob.target_work_id == work.id, ImportJob.checksum == asset.checksum, ImportJob.status.in_(("parsed", "applied"))).order_by(ImportJob.id.desc())
    )
    if existing and not allow_duplicate:
        # T-29: the same file imported again into the same draft is reported, not silently duplicated
        raise Invalid("Bu fayl allaqachon import qilingan", code="duplicate_import", import_id=existing.id, status=existing.status)
    from app.integrations.storage import get_storage

    data = await get_storage().get(asset.storage_key, asset.visibility == "public")
    try:
        if asset.kind == "docx":
            chapters, report = parse_docx(data)
        else:
            chapters, report = parse_text(data, markdown=asset.mime == "text/markdown" or True)
        status = "parsed"
    except Invalid as e:
        chapters, report, status = [], {"warnings": [e.message], "error": e.code}, "failed"
    report["detected_chapters"] = len(chapters)
    report["total_words"] = sum(c["words"] for c in chapters)
    key = f"{work.id}:{asset.checksum}:{'dup' if allow_duplicate else 'first'}:{asset.id}"
    job = ImportJob(owner_id=actor.id, source_asset_id=asset.id, target_work_id=work.id, parser_version=PARSER_VERSION, status=status, report=report, proposed=chapters, checksum=asset.checksum, idempotency_key=key)
    db.add(job)
    await db.flush()
    return job


async def apply_import(db: AsyncSession, actor: Actor, job: ImportJob, selected: list[int] | None = None, titles: dict[int, str] | None = None) -> list[int]:
    """Create DRAFT chapters from the reviewed proposal. Published text is never changed (T-30)."""
    if job.owner_id != actor.id and not actor.has("work.edit_any"):
        raise NotFound()
    if job.status != "parsed":
        raise Invalid("Import holati qo'llashga mos emas", code="import_state")
    work: Work = await get_work(db, job.target_work_id)  # type: ignore[arg-type]
    created: list[int] = []
    for i, ch in enumerate(job.proposed):
        if selected is not None and i not in selected:
            continue
        title = (titles or {}).get(i) or ch["title"]
        c = await add_chapter(db, actor, work, title=title, doc=ch["content"])
        created.append(c.id)
    job.status = "applied"
    job.created_chapters = created
    await audit(db, actor, "import.apply", "work", work.id, after={"import_id": job.id, "chapters": created})
    return created

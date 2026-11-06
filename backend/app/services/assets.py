"""Uploads, MIME sniffing, private/public storage, short-lived signed links (spec 17)."""

from __future__ import annotations

import hashlib
import secrets
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import Forbidden, Invalid, NotFound
from app.core.security import sign_payload, verify_payload
from app.integrations.storage import get_storage
from app.models import Asset, AssetLink, AuthorProfile, Chapter, StoryFrame, Work
from app.services.access import Entitlements, decide_chapter_access

MIB = 1024 * 1024


def sniff(data: bytes, filename: str = "") -> tuple[str, str]:
    """Return (kind, mime) from magic bytes. Never trust the client's Content-Type."""
    head = data[:16]
    name = filename.lower()
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image", "image/webp"
    if head.startswith(b"%PDF-"):
        return "pdf", "application/pdf"
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return "audio", "audio/mpeg"
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"M4A ", b"M4B "):
            return "audio", "audio/mp4"
        return "video", "video/mp4"
    if head.startswith(b"PK\x03\x04") and name.endswith(".docx"):
        return "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    is_text_name = name.endswith((".txt", ".md", ".markdown")) or not name
    sample = data[:200_000]
    if is_text_name and b"\x00" not in sample:
        # damaged bytes or a legacy encoding (cp1251) are reported by the importer, not rejected here
        return "text", "text/markdown" if name.endswith((".md", ".markdown")) else "text/plain"
    try:
        sample.decode("utf-8")
        if is_text_name:
            return "text", "text/plain"
    except UnicodeDecodeError:
        pass
    raise Invalid("Fayl turi qo'llab-quvvatlanmaydi (TXT, DOCX, MD, PDF, JPG/PNG/WebP, MP3/M4A, MP4)", code="unsupported_file")


def limit_for(kind: str, source: str) -> int:
    s = get_settings()
    if source == "bot":
        return s.limit_bot_file_mib * MIB
    return {
        "image": s.limit_image_mib,
        "text": s.limit_text_mib,
        "docx": s.limit_docx_mib,
        "pdf": s.limit_upload_media_mib,
        "audio": s.limit_upload_media_mib,
        "video": s.limit_upload_media_mib,
    }[kind] * MIB


def _media_meta(kind: str, data: bytes) -> dict:
    meta: dict = {}
    if kind == "image":
        if data.startswith(b"\x89PNG"):
            meta["width"] = int.from_bytes(data[16:20], "big")
            meta["height"] = int.from_bytes(data[20:24], "big")
    return meta


async def store_upload(db: AsyncSession, owner_id: int | None, data: bytes, filename: str, *, source: str = "app", public: bool = False, meta: dict | None = None) -> Asset:
    kind, mime = sniff(data, filename)
    if len(data) > limit_for(kind, source):
        raise Invalid(f"Fayl juda katta ({len(data) // MIB} MiB). Chegara: {limit_for(kind, source) // MIB} MiB", code="file_too_large")
    if kind == "docx":
        from app.services.importer import check_docx_container

        check_docx_container(data)
    checksum = hashlib.sha256(data).hexdigest()
    key = f"{kind}/{checksum[:2]}/{checksum}-{secrets.token_hex(4)}"
    # public only for cover/avatar images; originals are private by default
    public = public and kind == "image"
    await get_storage().put(key, data, mime, public)
    asset = Asset(
        owner_id=owner_id,
        original_name=filename[:255],
        mime=mime,
        kind=kind,
        size_bytes=len(data),
        checksum=checksum,
        storage_key=key,
        visibility="public" if public else "private",
        processing_state="ready",
        meta={**_media_meta(kind, data), **(meta or {})},
    )
    db.add(asset)
    await db.flush()
    return asset


async def make_public(db: AsyncSession, asset: Asset) -> None:
    if asset.kind != "image":
        raise Invalid("Faqat rasm ochiq bo'lishi mumkin", code="not_image")
    if asset.visibility != "public":
        await get_storage().make_public(asset.storage_key, asset.mime)
        asset.visibility = "public"


async def signed_media_url(db: AsyncSession, asset_id: int, ttl: int | None = None, download: bool = False) -> str | None:
    asset = await db.get(Asset, asset_id)
    if asset is None or asset.processing_state != "ready":
        return None
    if asset.visibility == "public":
        return get_storage().public_url(asset.storage_key)
    s = get_settings()
    token = sign_payload({"a": asset.id, "exp": int(time.time()) + (ttl or s.signed_url_ttl_seconds), "d": int(download)}, s.signing_key)
    return f"{s.public_base_url}/api/v1/assets/file?t={token}"


async def read_signed(db: AsyncSession, token: str) -> tuple[Asset, bytes, bool]:
    payload = verify_payload(token, get_settings().signing_key)
    asset = await db.get(Asset, int(payload["a"]))
    if asset is None:
        raise NotFound()
    data = await get_storage().get(asset.storage_key, asset.visibility == "public")
    return asset, data, bool(payload.get("d"))


async def asset_access(db: AsyncSession, asset_id: int, user_id: int | None, ent: Entitlements, staff_can_edit) -> dict:
    """The one gate for attachments/audio: entitlement is checked on every request (T-52, T-53)."""
    asset = await db.get(Asset, asset_id)
    if asset is None or asset.processing_state != "ready":
        raise NotFound("Fayl topilmadi")
    links = (await db.scalars(select(AssetLink).where(AssetLink.asset_id == asset.id))).all()
    if asset.visibility == "public":
        return {"url": get_storage().public_url(asset.storage_key), "download_allowed": True, "ttl": None}
    if asset.owner_id and asset.owner_id == user_id:
        return {"url": await signed_media_url(db, asset.id), "download_allowed": True, "ttl": get_settings().signed_url_ttl_seconds}
    allowed = False
    download = False
    for link in links:
        # evaluate each link on its own; a broad rule on one link never leaks another (spec 25 asset_links)
        if link.target_type == "chapter":
            ch = await db.get(Chapter, link.target_id)
            w = await db.get(Work, ch.work_id) if ch else None
            if ch and w and decide_chapter_access(w, ch, ent).full:
                allowed, download = True, download or link.download_allowed
        elif link.target_type == "work":
            w = await db.get(Work, link.target_id)
            if w is None or w.editorial_state not in ("published", "delisted"):
                continue
            if link.access_policy == "public" or w.access_policy == "FREE" or w.id in ent.work_ids or (ent.premium and w.access_policy in ("PREMIUM", "PREMIUM_OR_PURCHASE")):
                allowed, download = True, download or link.download_allowed
        elif link.target_type == "story_frame":
            f = await db.get(StoryFrame, link.target_id)
            if f and (f.audience == "all" or ent.premium):
                allowed = True
    if not allowed and await staff_can_edit(links):
        allowed, download = True, True
    if not allowed:
        raise Forbidden("Bu faylga kirish uchun huquq kerak", code="access_required")
    return {"url": await signed_media_url(db, asset.id, download=download), "download_allowed": download, "ttl": get_settings().signed_url_ttl_seconds}


async def link_asset(db: AsyncSession, asset: Asset, target_type: str, target_id: int, purpose: str, *, title: str = "", download_allowed: bool = False, access_policy: str = "inherit") -> AssetLink:
    if purpose not in ("cover", "attachment", "audio", "image", "story_media", "avatar"):
        raise Invalid()
    if purpose == "audio" and asset.kind != "audio":
        raise Invalid("Audio fayl kerak (MP3/M4A)", code="media_invalid")
    link = AssetLink(asset_id=asset.id, target_type=target_type, target_id=target_id, purpose=purpose, title=title[:200], download_allowed=download_allowed, access_policy=access_policy)
    db.add(link)
    if purpose == "audio" and target_type == "chapter":
        ch = await db.get(Chapter, target_id)
        if ch:
            ch.has_audio = True
    await db.flush()
    return link


async def set_author_avatar(db: AsyncSession, author: AuthorProfile, asset: Asset) -> None:
    await make_public(db, asset)
    author.avatar_asset_id = asset.id

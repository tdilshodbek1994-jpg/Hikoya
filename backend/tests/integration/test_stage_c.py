"""Stage C: media duration, antivirus, EPUB/PDF import, recap, characters, beta readers,
inline comments, quote cards, gifts, royalties, AI (T-59, T-60)."""

from __future__ import annotations

import asyncio
import io
import struct
import zipfile
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.config import get_settings
from app.core.errors import Invalid
from app.core.timeutil import utcnow
from app.integrations.media import mp4_duration
from app.models import (
    AIRequest,
    Chapter,
    ChapterRevision,
    EditorNote,
    Notification,
    Payment,
    QualifiedRead,
    ReadingSession,
    RoyaltyEntry,
    Work,
)
from app.services import ai, billing
from app.services.assets import store_upload
from app.services.importer import parse_epub, parse_pdf, start_import
from app.services.notify import process_outbox
from tests.conftest import H, login
from tests.helpers import actor_for, make_work, user_by_tg
from tests.integration.test_billing import enable_premium_price, order_for, pay


def _box(typ: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + typ + payload


def make_mp4(seconds: float, version: int = 0) -> bytes:
    ts = 1000
    if version == 1:
        mvhd = bytes([1, 0, 0, 0]) + struct.pack(">QQIQ", 0, 0, ts, int(seconds * ts)) + b"\0" * 80
    else:
        mvhd = bytes([0, 0, 0, 0]) + struct.pack(">IIII", 0, 0, ts, int(seconds * ts)) + b"\0" * 80
    return _box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41") + _box(b"free", b"") + _box(b"moov", _box(b"mvhd", mvhd)) + _box(b"mdat", b"\0" * 64)


async def _read_through(client, hdr, work_id: int, chapter: Chapter, seq: int, ratio: float = 1.0):
    r = await client.put("/api/v1/reading/progress", json={"work_id": work_id, "chapter_id": chapter.id, "ratio": ratio, "sequence": seq, "device_id": "d1"}, headers=hdr)
    assert r.status_code == 200, r.text


async def _blocks(db, chapter_id: int) -> list[dict]:
    ch = await db.get(Chapter, chapter_id)
    await db.refresh(ch)
    rev = await db.get(ChapterRevision, ch.published_revision_id or ch.draft_revision_id)
    return rev.content_json["content"]


# ------------------------------------------------------------------ media


def test_mp4_duration_parser():
    assert mp4_duration(make_mp4(12.5)) == 12.5
    assert mp4_duration(make_mp4(75, version=1)) == 75
    assert mp4_duration(b"\0\0\0\x18ftypisom" + b"\0" * 20) is None
    assert mp4_duration(make_mp4(10)[:40]) is None  # truncated file never reads past the buffer


async def test_video_duration_stored_and_long_story_video_rejected(client, db):
    owner = await actor_for(db, 1000)
    short = await store_upload(db, owner.id, make_mp4(20), "klip.mp4")
    long = await store_upload(db, owner.id, make_mp4(95), "uzun.mp4")
    await db.commit()
    assert short.meta["duration"] == 20 and long.meta["duration"] == 95
    hdr = H(await login(client, 1000))
    from app.services.identity import ensure_author_profile

    await ensure_author_profile(db, await user_by_tg(db, 1000))
    await db.commit()
    r = await client.post("/api/v1/studio/storis", json={"frames": [{"kind": "video", "media_asset_id": long.id}]}, headers=hdr)
    assert r.status_code == 422 and r.json()["error_code"] == "video_too_long"
    r = await client.post("/api/v1/studio/storis", json={"frames": [{"kind": "video", "media_asset_id": short.id}]}, headers=hdr)
    assert r.status_code == 200, r.text
    with pytest.raises(Invalid):
        await store_upload(db, owner.id, b"\0\0\0\x18ftypisom" + b"\0" * 40, "buzuq.mp4")


async def _fake_clamd(reply: bytes):
    async def handle(reader, writer):
        await reader.readuntil(b"\0")
        while True:
            n = struct.unpack(">I", await reader.readexactly(4))[0]
            if n == 0:
                break
            await reader.readexactly(n)
        writer.write(reply + b"\0")
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def test_antivirus_blocks_infected_and_handles_outage(db):
    s = get_settings()
    owner = await actor_for(db, 1000)
    server, port = await _fake_clamd(b"stream: Eicar-Test-Signature FOUND")
    old = (s.clamav_host, s.clamav_port, s.clamav_required)
    try:
        s.clamav_host, s.clamav_port = "127.0.0.1", port
        with pytest.raises(Invalid) as e:
            await store_upload(db, owner.id, b"X5O!P%@AP fake eicar", "virus.txt")
        assert e.value.code == "virus_found"
        server.close()
        server, port = await _fake_clamd(b"stream: OK")
        s.clamav_port = port
        a = await store_upload(db, owner.id, b"toza matn", "toza.txt")
        assert a.meta["av"] == "clean"
        server.close()
        await server.wait_closed()
        s.clamav_port = 1  # nothing listens: scanner unavailable
        a = await store_upload(db, owner.id, b"toza matn 2", "toza2.txt")
        assert a.meta["av"] == "unavailable"
        s.clamav_required = True
        with pytest.raises(Invalid) as e:
            await store_upload(db, owner.id, b"toza matn 3", "toza3.txt")
        assert e.value.code == "scanner_unavailable"
    finally:
        s.clamav_host, s.clamav_port, s.clamav_required = old
        server.close()


# ------------------------------------------------------------------ EPUB / PDF


def make_epub() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr(
            "OEBPS/content.opf",
            '<package><manifest><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>'
            '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
        )
        z.writestr("OEBPS/ch1.xhtml", "<html><head><style>p{}</style></head><body><h1>Birinchi bob</h1><p>Bahor <b>keldi</b>.</p><p>Ikkinchi xatboshi.</p><script>alert(1)</script></body></html>")
        z.writestr("OEBPS/ch2.xhtml", "<html><body><h2>Ikkinchi bob</h2><p>Yoz &amp; kuz.</p><img src='x.png'/></body></html>")
    return buf.getvalue()


def make_pdf(lines: list[str]) -> bytes:
    stream = "BT /F1 14 Tf 72 720 Td 18 TL " + " ".join(f"({ln}) Tj T*" for ln in lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def test_epub_parser_follows_spine_and_drops_scripts():
    chapters, report = parse_epub(make_epub())
    assert [c["title"] for c in chapters] == ["Birinchi bob", "Ikkinchi bob"]
    text = str(chapters[0]["content"])
    assert "keldi" in text and "alert" not in text and "p{}" not in text
    assert "Yoz & kuz." in str(chapters[1]["content"])
    assert any("rasm" in x for x in report["lost_formatting"])


def test_pdf_parser_text_layer_and_scanned():
    chapters, report = parse_pdf(make_pdf(["1-bob. Tong", "", "Quyosh chiqdi va", "qushlar sayradi."]))
    assert chapters and "Quyosh chiqdi" in str(chapters[0]["content"])
    assert any("PDF" in w for w in report["warnings"])
    with pytest.raises(Invalid) as e:
        parse_pdf(make_pdf([]))
    assert e.value.code == "pdf_no_text"


async def test_epub_upload_and_import_into_drafts(db):
    w, chs, owner = await make_work(db)
    asset = await store_upload(db, owner.id, make_epub(), "kitob.epub")
    assert asset.kind == "epub"
    job = await start_import(db, owner, asset, w.id)
    assert job.status == "parsed" and job.report["detected_chapters"] == 2


# ------------------------------------------------------------------ recap + characters


async def test_recap_only_after_previous_chapter_was_read(client, db):
    w, chs, owner = await make_work(db, chapters=3)
    ohdr = H(await login(client, 1000))
    r = await client.patch(f"/api/v1/studio/chapters/{chs[0].id}", json={"recap": "Ali shaharga keldi va eski do'stini uchratdi."}, headers=ohdr)
    assert r.status_code == 200
    hdr = H(await login(client, 8400))
    body = (await client.get(f"/api/v1/chapters/{chs[1].id}/content", headers=hdr)).json()
    assert body["recap"] is None  # jumped straight to chapter 2: no recap (it was never read)
    await _read_through(client, hdr, w.id, chs[0], 1)
    body = (await client.get(f"/api/v1/chapters/{chs[1].id}/content", headers=hdr)).json()
    assert body["recap"]["text"].startswith("Ali shaharga") and body["recap"]["chapter_id"] == chs[0].id


async def test_character_cards_hidden_until_reveal_chapter_read(client, db):
    w, chs, owner = await make_work(db, chapters=3)
    ohdr = H(await login(client, 1000))
    r = await client.post(f"/api/v1/studio/works/{w.id}/characters", json={"name": "Ali", "description": "Bosh qahramon"}, headers=ohdr)
    assert r.status_code == 200
    r = await client.post(f"/api/v1/studio/works/{w.id}/characters", json={"name": "Sirli mehmon", "description": "Aslida Alining akasi", "reveal_chapter_id": chs[1].id}, headers=ohdr)
    assert r.status_code == 200
    other_w, other_chs, _ = await make_work(db, title="Boshqa")
    bad = await client.post(f"/api/v1/studio/works/{w.id}/characters", json={"name": "X", "reveal_chapter_id": other_chs[0].id}, headers=ohdr)
    assert bad.status_code == 422
    hdr = H(await login(client, 8401))
    d = (await client.get(f"/api/v1/works/{w.id}/characters", headers=hdr)).json()
    assert [c["name"] for c in d["items"]] == ["Ali"] and d["hidden_count"] == 1
    assert "akasi" not in str(d)
    await _read_through(client, hdr, w.id, chs[1], 1)
    d = (await client.get(f"/api/v1/works/{w.id}/characters", headers=hdr)).json()
    assert {c["name"] for c in d["items"]} == {"Ali", "Sirli mehmon"} and d["hidden_count"] == 0
    stranger = H(await login(client, 8402))
    assert (await client.post(f"/api/v1/studio/works/{w.id}/characters", json={"name": "Y"}, headers=stranger)).status_code == 404


# ------------------------------------------------------------------ beta readers


async def test_beta_reader_invite_is_single_person_and_not_counted(client, db):
    w, chs, owner = await make_work(db, publish=False)
    ohdr = H(await login(client, 1000))
    r = await client.post(f"/api/v1/studio/works/{w.id}/beta-invites", json={"days": 7, "note": "Fikringizni yozing"}, headers=ohdr)
    assert r.status_code == 200, r.text
    inv = r.json()
    token = inv["link"].split("startapp=b_")[1]
    reader = H(await login(client, 8410))
    # the draft is invisible publicly
    assert (await client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=reader)).status_code == 404
    o = (await client.get(f"/api/v1/beta/{token}", headers=reader)).json()
    assert o["work"]["title"] == w.title and o["chapters"][0]["id"] == chs[0].id
    c = await client.get(f"/api/v1/beta/chapters/{chs[0].id}", headers=reader)
    assert c.status_code == 200 and c.json()["beta"] is True
    bid = c.json()["content"]["content"][2]["attrs"]["bid"]
    f = await client.post(f"/api/v1/beta/chapters/{chs[0].id}/feedback", json={"body": "Bu joy biroz cho'zilgan", "block_id": bid}, headers=reader)
    assert f.status_code == 200
    note = await db.get(EditorNote, f.json()["id"])
    assert note.body.startswith("[Beta]") and note.block_id == bid
    editor = (await client.get(f"/api/v1/studio/chapters/{chs[0].id}", headers=ohdr)).json()
    assert any(n["body"].startswith("[Beta]") for n in editor["notes"])
    # second person with the same link → 404; no stats were recorded
    other = H(await login(client, 8411))
    assert (await client.get(f"/api/v1/beta/{token}", headers=other)).status_code == 404
    assert (await client.get(f"/api/v1/beta/chapters/{chs[0].id}", headers=other)).status_code == 404
    assert await db.scalar(select(func.count()).select_from(ReadingSession)) == 0
    assert await db.scalar(select(func.count()).select_from(QualifiedRead)) == 0
    # revoke → access ends
    assert (await client.delete(f"/api/v1/studio/beta-invites/{inv['id']}", headers=ohdr)).status_code == 200
    assert (await client.get(f"/api/v1/beta/chapters/{chs[0].id}", headers=reader)).status_code == 404


# ------------------------------------------------------------------ inline comments


async def test_inline_comment_anchored_to_block(client, db):
    w, chs, _ = await make_work(db)
    blocks = await _blocks(db, chs[0].id)
    bid = blocks[3]["attrs"]["bid"]
    hdr = H(await login(client, 8420))
    r = await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "Ajoyib tasvir!", "chapter_id": chs[0].id, "client_key": "inl-000001", "block_id": bid, "quote": "so'z3_0 so'z3_1"}, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["block_id"] == bid and r.json()["quote"] == "so'z3_0 so'z3_1"
    bad = await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "x", "chapter_id": chs[0].id, "client_key": "inl-000002", "block_id": "nope0000"}, headers=hdr)
    assert bad.status_code == 422 and bad.json()["error_code"] == "block_not_found"
    await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "Umumiy sharh", "chapter_id": chs[0].id, "client_key": "inl-000003"}, headers=hdr)
    counts = (await client.get(f"/api/v1/works/{w.id}/chapters/{chs[0].id}/inline-counts", headers=hdr)).json()["counts"]
    assert counts == {bid: 1}
    only = (await client.get(f"/api/v1/works/{w.id}/comments", params={"chapter_id": chs[0].id, "block_id": bid}, headers=hdr)).json()
    assert len(only["items"]) == 1 and only["items"][0]["body"] == "Ajoyib tasvir!"


# ------------------------------------------------------------------ quotes


async def test_quote_card_only_from_readable_text(client, db):
    w, chs, _ = await make_work(db)
    pw, pchs, _ = await make_work(db, title="Pullik", policy="PREMIUM")
    blocks = await _blocks(db, chs[0].id)
    bid = blocks[5]["attrs"]["bid"]
    hdr = H(await login(client, 8430))
    r = await client.post("/api/v1/share/quote-card", json={"chapter_id": chs[0].id, "block_id": bid, "text": "so'z5_2 so'z5_3 so'z5_4"}, headers=hdr)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["image_url"].endswith(".png") and f"startapp=c_{chs[0].id}" in d["link"]
    from app.integrations.storage import get_storage

    key = d["image_url"].split("/quotes/")[1]
    png = await get_storage().get("quotes/" + key, True)
    assert png.startswith(b"\x89PNG")
    bad = await client.post("/api/v1/share/quote-card", json={"chapter_id": chs[0].id, "block_id": bid, "text": "o'ylab topilgan gap"}, headers=hdr)
    assert bad.json()["error_code"] == "quote_mismatch"
    pblocks = await _blocks(db, pchs[0].id)
    locked = await client.post("/api/v1/share/quote-card", json={"chapter_id": pchs[0].id, "block_id": pblocks[20]["attrs"]["bid"], "text": "so'z20_1"}, headers=hdr)
    assert locked.status_code == 403


async def test_author_quote_storis_draft_then_submit(client, db):
    w, chs, owner = await make_work(db)
    from app.services.identity import ensure_author_profile

    await ensure_author_profile(db, await user_by_tg(db, 1000))
    await db.commit()
    blocks = await _blocks(db, chs[0].id)
    ohdr = H(await login(client, 1000))
    r = await client.post("/api/v1/studio/storis/quote-draft", json={"chapter_id": chs[0].id, "block_id": blocks[1]["attrs"]["bid"], "text": "so'z1_0 so'z1_1", "theme": "night"}, headers=ohdr)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "draft"
    s = await client.post(f"/api/v1/studio/storis/{r.json()['id']}/submit", headers=ohdr)
    assert s.status_code == 200 and s.json()["status"] in ("published", "pending")
    stranger = H(await login(client, 8431))
    r2 = await client.post("/api/v1/studio/storis/quote-draft", json={"chapter_id": chs[0].id, "block_id": blocks[1]["attrs"]["bid"], "text": "so'z1_0"}, headers=stranger)
    assert r2.status_code == 404


# ------------------------------------------------------------------ gifts + royalties


async def test_gift_purchase_grants_recipient_not_payer(client, db):
    owner = await actor_for(db, 1000)
    w, chs, _ = await make_work(db, policy="PURCHASE")
    p = await billing.create_work_product(db, owner, await db.get(Work, w.id), 40)
    await db.commit()
    payer = H(await login(client, 8440, "Ota"))
    friend = H(await login(client, 8441, "Do'st"))
    r = await client.post("/api/v1/billing/orders", json={"product_id": p.id, "gift_to_telegram_id": 8441}, headers={**payer, "Idempotency-Key": "gift-000001"})
    assert r.status_code == 200, r.text
    nobody = await client.post("/api/v1/billing/orders", json={"product_id": p.id, "gift_to_telegram_id": 5555}, headers={**payer, "Idempotency-Key": "gift-000002"})
    assert nobody.status_code == 422 and nobody.json()["error_code"] == "recipient_not_found"
    await pay(db, 8440, r.json()["id"], "charge-GIFT1")
    mode = lambda h: client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=h)  # noqa: E731
    assert (await mode(friend)).json()["mode"] == "full"
    assert (await mode(payer)).json()["mode"] == "preview"
    await process_outbox(db)
    await db.commit()
    friend_user = await user_by_tg(db, 8441)
    n = await db.scalar(select(Notification).where(Notification.user_id == friend_user.id, Notification.type == "billing"))
    assert n is not None and "sovg'a" in n.body
    # the same gift again is refused: the friend already has the work
    again = await client.post("/api/v1/billing/orders", json={"product_id": p.id, "gift_to_telegram_id": 8441}, headers={**payer, "Idempotency-Key": "gift-000003"})
    assert again.status_code == 409
    prem = await enable_premium_price(db)
    sub = await client.post("/api/v1/billing/orders", json={"product_id": prem.id, "gift_to_telegram_id": 8441}, headers={**payer, "Idempotency-Key": "gift-000004"})
    assert sub.status_code == 422 and sub.json()["error_code"] == "gift_subscription"


async def test_royalty_ledger_pending_available_reversed(client, db):
    s = get_settings()
    old = s.royalty_share_percent
    s.royalty_share_percent = 70
    try:
        owner = await actor_for(db, 1000)
        from app.services.identity import ensure_author_profile

        await ensure_author_profile(db, owner.user)
        await db.commit()
        w, chs, _ = await make_work(db, policy="PURCHASE")
        p = await billing.create_work_product(db, owner, await db.get(Work, w.id), 100)
        await db.commit()
        for i, tg in enumerate((8450, 8451)):
            hdr = H(await login(client, tg))
            o = await order_for(client, hdr, p.id, f"roy-00000{i}")
            await pay(db, tg, o["id"], f"charge-ROY{i}")
        entries = (await db.scalars(select(RoyaltyEntry).order_by(RoyaltyEntry.id))).all()
        assert [(e.amount_stars, e.state) for e in entries] == [(70, "pending"), (70, "pending")]
        ohdr = H(await login(client, 1000))
        summ = (await client.get("/api/v1/studio/royalties", params={"author_id": entries[0].author_id}, headers=ohdr)).json()
        assert summ["by_state"]["pending"]["stars"] == 140 and summ["payable_stars"] == 0
        # hold period passes
        for e in entries:
            e.available_at = utcnow() - timedelta(minutes=1)
        await db.commit()
        assert await billing.mature_royalties(db) == 2
        await db.commit()
        # refund of the first sale reverses its royalty
        pay0 = await db.scalar(select(Payment).where(Payment.telegram_charge_id == "charge-ROY0"))
        r = await client.post(f"/api/v1/admin/billing/payments/{pay0.id}/refund", json={"reason": "qaytarish", "request_key": "roy-rf-0001"}, headers=ohdr)
        assert r.json()["state"] == "succeeded"
        await db.refresh(entries[0])
        await db.refresh(entries[1])
        assert entries[0].state == "reversed" and entries[1].state == "available"
        payout = await client.post(f"/api/v1/admin/royalties/{entries[0].author_id}/payout", json={"note": "Click orqali o'tkazildi"}, headers=ohdr)
        assert payout.status_code == 200 and payout.json()["amount"] == 70
        again = await client.post(f"/api/v1/admin/royalties/{entries[0].author_id}/payout", json={"note": "ikkinchi marta"}, headers=ohdr)
        assert again.status_code == 422
        reader = H(await login(client, 8452))
        assert (await client.get("/api/v1/admin/royalties", headers=reader)).status_code == 403
    finally:
        s.royalty_share_percent = old


# ------------------------------------------------------------------ AI (T-59, T-60)


class FakeProvider:
    def __init__(self, data=None, refuse=False, fail=None):
        self.data, self.refuse, self.fail = data or {}, refuse, fail
        self.prompts: list[str] = []

    async def complete(self, *, system, prompt, schema, effort="medium"):
        self.prompts.append(prompt)
        if self.fail:
            raise self.fail
        if self.refuse:
            return ai.AIResult(data={}, model="fake", refused=True, refusal_category="bio")
        d = self.data(prompt) if callable(self.data) else self.data
        return ai.AIResult(data=d, model="fake", input_tokens=10, output_tokens=5)


@pytest.fixture
def fake_ai():
    holder = {}

    def use(p):
        ai.set_provider(p)
        holder["p"] = p
        return p

    yield use
    ai.set_provider(None)


async def test_ai_disabled_by_default(client, db):
    w, chs, _ = await make_work(db)
    hdr = H(await login(client, 1000))
    assert (await client.get("/api/v1/ai/status")).json()["enabled"] is False
    r = await client.post(f"/api/v1/studio/ai/works/{w.id}/synopsis", headers=hdr)
    assert r.status_code == 403 and r.json()["error_code"] == "ai_disabled"


async def test_ai_reader_recap_sees_only_read_and_accessible_chapters(client, db, fake_ai):
    """T-59: unread chapters and chapters behind a paywall never reach the model."""
    owner = await actor_for(db, 1000)
    from app.services import content as content_svc
    from tests.helpers import doc

    w = await content_svc.create_work(db, owner, title="Aralash", synopsis="", access_policy="PREMIUM")
    c1 = await content_svc.add_chapter(db, owner, w, title="Ochiq bob", doc=doc("OCHIQMATN birinchi bob voqealari."))
    c2 = await content_svc.add_chapter(db, owner, w, title="Pullik bob", doc=doc("PREMIUMSIR yashirin davom."))
    c3 = await content_svc.add_chapter(db, owner, w, title="O'qilmagan bob", doc=doc("SPOILERMATN yakun."))
    await content_svc.update_chapter_meta(db, owner, c1, {"access_override": "free_sample"})
    await content_svc.update_chapter_meta(db, owner, c3, {"access_override": "free_sample"})
    await content_svc.publish_now(db, owner, w)
    await db.commit()
    p = fake_ai(FakeProvider({"recap": "Qisqacha.", "characters": [{"name": "Ali", "note": "qahramon"}]}))
    hdr = H(await login(client, 8460))
    r = await client.post(f"/api/v1/ai/works/{w.id}/recap", headers=hdr)
    assert r.status_code == 422 and r.json()["error_code"] == "nothing_read"
    await _read_through(client, hdr, w.id, c1, 1)
    # the reader read the premium chapter while a Premium grant was active, then it was refunded
    from app.models import EntitlementGrant

    reader = await user_by_tg(db, 8460)
    await billing._grant(db, reader.id, "manual", "t59", "premium", 0, utcnow(), utcnow() + timedelta(days=1), {})
    await db.commit()
    await _read_through(client, hdr, w.id, c2, 2)
    g = await db.scalar(select(EntitlementGrant).where(EntitlementGrant.source_id == "t59"))
    g.revoked_at = utcnow()
    await db.commit()
    r = await client.post(f"/api/v1/ai/works/{w.id}/recap", headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok" and r.json()["recap"] == "Qisqacha."
    prompt = p.prompts[-1]
    assert "OCHIQMATN" in prompt
    assert "PREMIUMSIR" not in prompt  # no access now → never sent
    assert "SPOILERMATN" not in prompt  # not read → never sent
    assert await db.scalar(select(func.count()).select_from(AIRequest).where(AIRequest.kind == "recap")) == 1


async def test_ai_refusal_and_outage_are_explained(client, db, fake_ai):
    """T-60."""
    w, chs, _ = await make_work(db)
    hdr = H(await login(client, 1000))
    fake_ai(FakeProvider(refuse=True))
    r = await client.post(f"/api/v1/studio/ai/works/{w.id}/synopsis", headers=hdr)
    assert r.status_code == 200 and r.json()["status"] == "refused" and "message" in r.json()
    fake_ai(FakeProvider(fail=ai.AIUnavailable("AI xizmatiga ulanib bo'lmadi", code="ai_unreachable")))
    r = await client.post(f"/api/v1/studio/ai/works/{w.id}/synopsis", headers=hdr)
    assert r.status_code == 503 and r.json()["error_code"] == "ai_unreachable"
    # the work itself is untouched
    await db.refresh(await db.get(Work, w.id))
    assert (await db.get(Work, w.id)).synopsis == "Qisqa annotatsiya"


async def test_ai_synopsis_and_proofread_accept_flow(client, db, fake_ai):
    w, chs, _ = await make_work(db)
    blocks = await _blocks(db, chs[0].id)
    b1, b2 = blocks[1]["attrs"]["bid"], blocks[2]["attrs"]["bid"]
    hdr = H(await login(client, 1000))
    fake_ai(FakeProvider({"variants": [{"tone": "sokin", "text": "Bir"}, {"tone": "qiziq", "text": "Ikki"}, {"tone": "qisqa", "text": "Uch"}]}))
    r = await client.post(f"/api/v1/studio/ai/works/{w.id}/synopsis", headers=hdr)
    assert [v["text"] for v in r.json()["variants"]] == ["Bir", "Ikki", "Uch"]
    fake_ai(FakeProvider({"suggestions": [
        {"block_id": b1, "original": "so'z1_0", "replacement": "So'z1_0", "reason": "bosh harf"},
        {"block_id": b2, "original": "so'z2_5", "replacement": "so'z2-5", "reason": "chiziqcha"},
        {"block_id": b2, "original": "YO'Q MATN", "replacement": "x", "reason": "uydirma"},
        {"block_id": "bad", "original": "so'z1_0", "replacement": "x", "reason": "noto'g'ri blok"},
    ]}))
    r = await client.post(f"/api/v1/studio/ai/chapters/{chs[0].id}/proofread", headers=hdr)
    d = r.json()
    assert len(d["suggestions"]) == 2  # invented text and unknown blocks are dropped
    stranger = H(await login(client, 8470))
    assert (await client.post(f"/api/v1/studio/ai/proofread/{d['request_id']}/apply", json={"accepted": [0]}, headers=stranger)).status_code == 404
    r = await client.post(f"/api/v1/studio/ai/proofread/{d['request_id']}/apply", json={"accepted": [0]}, headers=hdr)
    assert r.status_code == 200 and r.json()["applied"] == [0]
    rev = await db.get(ChapterRevision, r.json()["revision_id"])
    text = str(rev.content_json)
    assert "So'z1_0" in text and "so'z2-5" not in text
    ch = await db.get(Chapter, chs[0].id)
    await db.refresh(ch)
    assert ch.draft_revision_id == rev.id and ch.published_revision_id != rev.id  # published text untouched
    again = await client.post(f"/api/v1/studio/ai/proofread/{d['request_id']}/apply", json={"accepted": [1]}, headers=hdr)
    assert again.status_code == 409
    # suggestions on a stale revision → 409 conflict, nothing lost
    r = await client.post(f"/api/v1/studio/ai/chapters/{chs[0].id}/proofread", headers=hdr)
    stale_id = r.json()["request_id"]
    assert len(r.json()["suggestions"]) == 1  # the accepted fix is already in the text
    saved = await client.post(f"/api/v1/studio/chapters/{chs[0].id}/revisions", json={"content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Yangi matn"}]}]}, "base_revision_id": rev.id}, headers=hdr)
    assert saved.status_code == 200, saved.text
    r = await client.post(f"/api/v1/studio/ai/proofread/{stale_id}/apply", json={"accepted": [0]}, headers=hdr)
    assert r.status_code == 409 and r.json()["error_code"] == "revision_conflict"


async def test_ai_nl_search_filters_and_daily_limit(client, db, fake_ai):
    s = get_settings()
    fake_ai(FakeProvider({"query": "", "genres": ["hayotiy", "yo'q-janr"], "access": "free", "status": "completed", "format": "any", "max_minutes": 20, "has_audio": False}))
    hdr = H(await login(client, 8480))
    r = await client.post("/api/v1/ai/search", json={"text": "qisqa tugallangan hayotiy hikoya bepul"}, headers=hdr)
    assert r.json()["filters"] == {"genre": ["hayotiy"], "access": "free", "status": "completed", "max_minutes": 20}
    old = s.ai_daily_limit_per_user
    s.ai_daily_limit_per_user = 1
    try:
        r = await client.post("/api/v1/ai/search", json={"text": "yana bir so'rov"}, headers=hdr)
        assert r.status_code == 429
    finally:
        s.ai_daily_limit_per_user = old


async def test_anthropic_provider_request_shape(monkeypatch):
    """The SDK call uses structured output, effort, and the server-side refusal fallback."""
    import json as _json
    from types import SimpleNamespace

    s = get_settings()
    p = ai.AnthropicProvider("sk-test", s.ai_model, 1000)
    seen = {}

    async def fake_create(**kw):
        seen.update(kw)
        return SimpleNamespace(stop_reason="end_turn", model="claude-opus-5-5", usage=SimpleNamespace(input_tokens=3, output_tokens=2), content=[SimpleNamespace(type="text", text=_json.dumps({"ok": 1}))])

    monkeypatch.setattr(p.client.beta.messages, "create", fake_create)
    res = await p.complete(system="sys", prompt="hi", schema={"type": "object"}, effort="low")
    assert res.data == {"ok": 1} and res.input_tokens == 3
    assert seen["model"] == "claude-opus-5-5" and seen["fallbacks"] == "default"
    assert seen["betas"] == [ai.FALLBACK_BETA]
    assert seen["output_config"]["format"]["type"] == "json_schema" and seen["output_config"]["effort"] == "low"
    assert "temperature" not in seen

    async def refuse(**kw):
        return SimpleNamespace(stop_reason="refusal", model="claude-opus-5-5", stop_details=SimpleNamespace(category="bio"), usage=None, content=[])

    monkeypatch.setattr(p.client.beta.messages, "create", refuse)
    res = await p.complete(system="sys", prompt="hi", schema={"type": "object"})
    assert res.refused and res.refusal_category == "bio"

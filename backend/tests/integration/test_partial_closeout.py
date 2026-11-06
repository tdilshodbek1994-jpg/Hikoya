"""Closing partial acceptance items: T-30, T-42 (second real parallel payment), T-58."""

from datetime import timedelta

from sqlalchemy import func, select

from app.core.timeutil import utcnow
from app.models import Chapter, Order, Payment, Subscription, SupportTicket
from app.services.assets import store_upload
from app.services.importer import apply_import, start_import
from tests.conftest import H, login
from tests.helpers import make_work, user_by_tg
from tests.integration.test_billing import enable_premium_price, order_for, pay


async def test_import_with_damaged_section_reports_and_keeps_published(db):
    """T-30: one damaged part → warning in the report; published text untouched; draft chapters only."""
    w, chs, owner = await make_work(db)
    published = chs[0].published_revision_id
    data = "1-bob. Boshi\n\nToza matn bu yerda.\n\n2-bob. Buzilgan\n\n".encode() + b"\xff\xfe\xfa buzuq \xc3" + "\n\n3-bob. Oxiri\n\nYana toza matn.".encode()
    asset = await store_upload(db, owner.id, data, "aralash.txt")
    job = await start_import(db, owner, asset, w.id)
    assert job.status == "parsed"
    assert any("tanilmadi" in x for x in job.report["warnings"])
    assert len(job.proposed) == 3
    created = await apply_import(db, owner, job)
    await db.commit()
    ch = await db.get(Chapter, chs[0].id)
    await db.refresh(ch)
    assert ch.published_revision_id == published
    for cid in created:
        c = await db.get(Chapter, cid)
        assert c.published_revision_id is None and c.draft_revision_id


async def test_second_real_parallel_subscription_payment_goes_to_review(client, db):
    """T-42: if a second real payment arrives anyway it is kept, access stays, a review ticket opens."""
    p = await enable_premium_price(db)
    hdr = H(await login(client, 8200))
    o1 = await order_for(client, hdr, p.id, "par-1-0001")
    # the first checkout expired on the client, a second one was opened
    first = await db.get(Order, o1["id"])
    first.expires_at = utcnow() - timedelta(minutes=1)
    await db.commit()
    o2 = await order_for(client, hdr, p.id, "par-2-0001")
    assert o2["id"] != o1["id"]
    await pay(db, 8200, o2["id"], "charge-PAR2")
    await pay(db, 8200, o1["id"], "charge-PAR1")  # late real payment of the old invoice
    pays = (await db.scalars(select(Payment).order_by(Payment.id))).all()
    assert len(pays) == 2
    assert pays[1].state == "needs_review" and "Parallel" in pays[1].review_reason
    assert await db.scalar(select(func.count()).select_from(Subscription)) == 2
    assert await db.scalar(select(func.count()).select_from(SupportTicket).where(SupportTicket.payment_id == pays[1].id)) == 1
    me = (await client.get("/api/v1/me/entitlements", headers=hdr)).json()
    assert me["premium"] is True


async def test_author_stats_csv_only_aggregates(client, db):
    """T-58."""
    w, chs, _ = await make_work(db, owner_tg=1000)
    reader = H(await login(client, 8300))
    await client.post(f"/api/v1/highlights", json={"chapter_id": chs[0].id, "block_id": "b0000000", "quote": "maxfiy iqtibos", "note": "shaxsiy eslatma"}, headers=reader)
    owner = H(await login(client, 1000))
    r = await client.get(f"/api/v1/studio/works/{w.id}/stats.csv", headers=owner)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    body = r.text
    assert "unique_qualified_readers" in body
    u = await user_by_tg(db, 8300)
    assert "maxfiy" not in body and "shaxsiy" not in body and str(u.telegram_user_id) not in body
    other = H(await login(client, 8301))
    assert (await client.get(f"/api/v1/studio/works/{w.id}/stats.csv", headers=other)).status_code in (403, 404)


async def test_cp1251_cyrillic_text_import(db):
    w, _, owner = await make_work(db)
    data = "1-боб. Бошланиш\n\nБу кирилл матни.\n\n2-боб. Давоми\n\nЯна матн.".encode("cp1251")
    asset = await store_upload(db, owner.id, data, "kirill.txt")
    job = await start_import(db, owner, asset, w.id)
    assert job.status == "parsed" and any("1251" in x for x in job.report["warnings"])
    assert "кирилл" in str(job.proposed[0]["content"])


async def test_reading_report(client, db):
    from app.models import ReadingSession

    w, chs, _ = await make_work(db)
    hdr = H(await login(client, 8400))
    await client.patch("/api/v1/me/preferences", json={"daily_goal_minutes": 10}, headers=hdr)
    c = (await client.get(f"/api/v1/chapters/{chs[0].id}/content", params={"device_id": "d"}, headers=hdr)).json()
    s = await db.scalar(select(ReadingSession).where(ReadingSession.public_id == c["session_id"]))
    s.active_seconds = 12 * 60
    await db.commit()
    r = (await client.get("/api/v1/me/reading-report", headers=hdr)).json()
    assert len(r["week"]) == 7 and r["today_minutes"] == 12 and r["goal_reached_today"] is True and r["streak_days"] == 1


async def test_image_variants_strip_exif_and_reject_bombs(client, db):
    import io

    from PIL import Image

    from app.models import Asset
    from app.services.assets import store_upload

    img = Image.new("RGB", (1200, 1800), (120, 90, 200))
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"  # Make
    exif[0x0110] = "Model-X"
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    w, _, owner = await make_work(db)
    a = await store_upload(db, owner.id, buf.getvalue(), "muqova.jpg", public=True)
    assert a.meta["width"] == 1200 and set(a.meta["variants"]) == {"240", "640"}
    from app.integrations.storage import get_storage

    small = await get_storage().get(a.meta["variants"]["240"], True)
    v = Image.open(io.BytesIO(small))
    assert v.width == 240 and v.format == "WEBP" and not v.getexif().get(0x010F) and b"SecretCam" not in small
    orig = await get_storage().get(a.storage_key, True)
    assert b"SecretCam" not in orig
    w.cover_asset_id = a.id
    await db.commit()
    card = (await client.get("/api/v1/works")).json()["items"][0]
    assert card["cover_url"].endswith("-w240.webp")
    import pytest

    from app.core.errors import Invalid

    with pytest.raises(Invalid):
        await store_upload(db, owner.id, b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, "buzuq.png")
    assert await db.get(Asset, a.id)

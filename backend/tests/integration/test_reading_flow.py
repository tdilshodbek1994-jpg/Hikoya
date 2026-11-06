"""Stage A vertical flow + reading acceptance tests (T-01, T-03, T-11..T-17, T-25..T-27, T-52)."""

from datetime import date, timedelta

from sqlalchemy import select

from app.models import Chapter, QualifiedRead, ReadingSession
from app.services import content as content_svc
from tests.conftest import H, login
from tests.helpers import doc, make_work


async def test_onboarding_skip_and_catalog_opens(client, db):
    """T-01: new user skips genre choice, catalogue opens, no phone number asked."""
    await make_work(db, title="Birinchi hikoya")
    auth = await login(client, 5001)
    assert auth["_me"]["onboarding_done"] is False
    r = await client.patch("/api/v1/me/preferences", json={"onboarding_done": True}, headers=H(auth))
    assert r.status_code == 200 and r.json()["onboarding_done"] is True
    r = await client.get("/api/v1/home", headers=H(auth))
    assert r.status_code == 200
    kinds = [s["kind"] for s in r.json()["sections"]]
    assert kinds[:2] == ["stories", "genres"]
    r = await client.get("/api/v1/works", headers=H(auth))
    assert [w["title"] for w in r.json()["items"]] == ["Birinchi hikoya"]


async def test_filters_premium_genre_completed(client, db):
    """T-03: Premium + Detektiv + Completed; Premium is not a genre."""
    await make_work(db, title="A", genre="detektiv", policy="PREMIUM", completion="completed")
    await make_work(db, title="B", genre="detektiv", policy="FREE", completion="completed")
    await make_work(db, title="C", genre="detektiv", policy="PREMIUM", completion="ongoing")
    await make_work(db, title="D", genre="sevgi", policy="PREMIUM", completion="completed")
    r = await client.get("/api/v1/works", params={"access": "premium", "genre": "detektiv", "status": "completed"})
    assert [w["title"] for w in r.json()["items"]] == ["A"]
    genres = [g["slug"] for g in (await client.get("/api/v1/genres")).json()]
    assert "premium" not in genres


async def test_search_cyrillic_and_apostrophe(client, db):
    """T-05."""
    await make_work(db, title="Oʻzbek qishlogʻi")
    for q in ["o'zbek qishlog'i", "Ўзбек қишлоғи", "O‘zbek", "ozbek"]:
        r = await client.get("/api/v1/search", params={"q": q})
        assert [w["title"] for w in r.json()["items"]] == ["Oʻzbek qishlogʻi"], q


async def test_premium_chapter_returns_only_preview(client, db):
    """T-52 / F-07: free user gets preview blocks only, never the full body."""
    w, chs, _ = await make_work(db, title="Pulli", policy="PREMIUM", paras=20)
    auth = await login(client, 5002)
    r = await client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=H(auth))
    body = r.json()
    assert r.status_code == 200 and body["mode"] == "preview"
    assert len(body["content"]["content"]) == chs[0].preview_blocks
    assert body["access"]["offers"] == ["premium"]
    assert body["session_id"] is None
    # anonymous too
    r = await client.get(f"/api/v1/chapters/{chs[0].id}/content")
    assert r.json()["mode"] == "preview"


async def test_progress_current_vs_furthest_and_stale_events(client, db):
    """T-12, T-13, T-14."""
    w, chs, _ = await make_work(db, title="Roman", chapters=7, completion="ongoing")
    auth = await login(client, 5003)
    hdr = H(auth)
    dev = "dev-A"
    r = await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[6].id, "ratio": 1.0, "sequence": 10, "device_id": dev, "block_id": ""}, headers=hdr)
    assert r.json()["status"] == "saved"
    # back to chapter 2 (conscious choice)
    r = await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[1].id, "ratio": 0.3, "sequence": 11, "device_id": dev}, headers=hdr)
    p = r.json()["progress"]
    assert p["chapter_id"] == chs[1].id and p["furthest_chapter_id"] == chs[6].id and p["furthest_ratio"] == 1.0
    # an older event arriving late is ignored
    r = await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[5].id, "ratio": 0.9, "sequence": 9, "device_id": dev}, headers=hdr)
    assert r.json()["status"] == "stale_ignored" and r.json()["progress"]["chapter_id"] == chs[1].id
    # reopening the work: continue from chapter 2
    r = await client.get(f"/api/v1/works/{w.short_code}", headers=hdr)
    assert r.json()["user_state"]["progress"]["chapter_id"] == chs[1].id
    assert r.json()["start_action"] == "continue"


async def test_two_devices_conflict(client, db):
    """T-15: stale position from another device does not silently overwrite."""
    w, chs, _ = await make_work(db, chapters=5, completion="ongoing")
    hdr = H(await login(client, 5004))
    await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[4].id, "ratio": 0.5, "sequence": 1, "device_id": "phone"}, headers=hdr)
    old_ts = "2020-01-01T00:00:00Z"
    r = await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[0].id, "ratio": 0.1, "sequence": 1, "device_id": "tablet", "client_ts": old_ts}, headers=hdr)
    assert r.json()["status"] == "conflict" and r.json()["other"]["chapter_id"] == chs[4].id
    r = await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[0].id, "ratio": 0.1, "sequence": 2, "device_id": "tablet", "force": True}, headers=hdr)
    assert r.json()["status"] == "saved" and r.json()["progress"]["chapter_id"] == chs[0].id


async def test_font_change_keeps_block_anchor_and_text_edit_maps_position(client, db):
    """T-11 (position is a block id, not a pixel offset) and T-17 (removed block → nearest)."""
    w, chs, owner = await make_work(db, paras=10)
    hdr = H(await login(client, 5005))
    content = (await client.get(f"/api/v1/chapters/{chs[0].id}/content", params={"device_id": "d"}, headers=hdr)).json()
    blocks = content["content"]["content"]
    target = blocks[5]["attrs"]["bid"]
    await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[0].id, "revision_id": content["revision_id"], "block_id": target, "ratio": 0.5, "sequence": 1, "device_id": "d"}, headers=hdr)
    # font size change only changes reader_settings; anchor stays
    await client.patch("/api/v1/me/preferences", json={"reader_settings": {"font_size": 28}}, headers=hdr)
    again = (await client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=hdr)).json()
    assert again["position"]["block_id"] == target and again["position"]["text_updated"] is False
    # author removes that paragraph and republishes
    ch = await db.get(Chapter, chs[0].id)
    await db.refresh(ch)
    new = {"type": "doc", "content": [b for b in blocks if b["attrs"]["bid"] != target]}
    await content_svc.save_revision(db, owner, ch, new, ch.published_revision_id)
    await content_svc.publish_now(db, owner, w)
    await db.commit()
    moved = (await client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=hdr)).json()
    assert moved["position"]["block_id"] == blocks[4]["attrs"]["bid"]
    assert moved["position"]["text_updated"] is True


async def _read_session(client, hdr, chapter_id, blocks_fraction=0.5, seconds=50.0, eid_prefix="e"):
    c = (await client.get(f"/api/v1/chapters/{chapter_id}/content", params={"device_id": "d"}, headers=hdr)).json()
    ids = [b["attrs"]["bid"] for b in c["content"]["content"]]
    n = int(len(ids) * blocks_fraction)
    ev = [{"event_id": f"{eid_prefix}-{c['session_id']}-{i}", "session_id": c["session_id"], "sequence": i, "type": "blocks", "blocks": ids[i * 5 : (i + 1) * 5], "active_seconds": seconds / max(1, n // 5 + 1)} for i in range(n // 5 + 1)]
    return c, ev


async def test_qualified_read_unique_per_period(client, db):
    """T-25, T-27: one user reading 6 chapters many times = 1 unique reader in the weekly TOP."""
    w, chs, _ = await make_work(db, chapters=6, paras=20)
    hdr = H(await login(client, 5006))
    # sessions need wall-clock time: backdate session start for the test
    for ch in chs:
        for k in range(3):
            c, ev = await _read_session(client, hdr, ch.id, eid_prefix=f"x{k}")
            s = await db.scalar(select(ReadingSession).where(ReadingSession.public_id == c["session_id"]))
            s.started_at = s.started_at - timedelta(minutes=5)
            s.last_seen_at = s.started_at
            await db.commit()
            r = await client.post("/api/v1/reading/events/batch", json={"events": ev}, headers=hdr)
            assert r.status_code == 200
    rows = (await db.scalars(select(QualifiedRead).where(QualifiedRead.work_id == w.id))).all()
    assert len(rows) == 1
    # same user on three different days → 3 daily rows but still 1 unique in the weekly ranking
    rows[0].local_date = rows[0].local_date
    db.add(QualifiedRead(user_id=rows[0].user_id, work_id=w.id, local_date=rows[0].local_date - timedelta(days=1)))
    db.add(QualifiedRead(user_id=rows[0].user_id, work_id=w.id, local_date=rows[0].local_date - timedelta(days=2)))
    await db.commit()
    r = await client.get("/api/v1/rankings", params={"metric": "most_read", "period": "all"})
    items = r.json()["items"]
    assert items[0]["id"] == w.id and items[0]["score"] == 1


async def test_fast_scroll_and_short_time_not_qualified(client, db):
    w, chs, _ = await make_work(db, paras=40)
    hdr = H(await login(client, 5007))
    c, ev = await _read_session(client, hdr, chs[0].id, blocks_fraction=1.0, seconds=2.0)
    await client.post("/api/v1/reading/events/batch", json={"events": ev}, headers=hdr)
    assert (await db.scalar(select(QualifiedRead.id).where(QualifiedRead.work_id == w.id))) is None


async def test_author_own_reading_not_counted(client, db):
    """T-26 (author excluded from TOP)."""
    w, chs, _ = await make_work(db, owner_tg=1000, paras=20)
    hdr = H(await login(client, 1000))
    c, ev = await _read_session(client, hdr, chs[0].id)
    s = await db.scalar(select(ReadingSession).where(ReadingSession.public_id == c["session_id"]))
    s.started_at -= timedelta(minutes=5)
    await db.commit()
    await client.post("/api/v1/reading/events/batch", json={"events": ev}, headers=hdr)
    assert (await db.scalar(select(QualifiedRead.id).where(QualifiedRead.work_id == w.id))) is None


async def test_duplicate_events_resent_offline(client, db):
    """T-16: offline queue resent → accepted once."""
    w, chs, _ = await make_work(db, paras=20)
    hdr = H(await login(client, 5008))
    c, ev = await _read_session(client, hdr, chs[0].id)
    r1 = (await client.post("/api/v1/reading/events/batch", json={"events": ev}, headers=hdr)).json()
    r2 = (await client.post("/api/v1/reading/events/batch", json={"events": ev}, headers=hdr)).json()
    assert r1["accepted"] == len(ev) and r2["accepted"] == 0


async def test_edit_after_publish_keeps_old_revision_for_readers(client, db):
    """T-31."""
    w, chs, owner = await make_work(db)
    ch = await db.get(Chapter, chs[0].id)
    published = ch.published_revision_id
    await content_svc.save_revision(db, owner, ch, doc("Yangi matn"), published)
    await db.commit()
    hdr = H(await login(client, 5009))
    r = (await client.get(f"/api/v1/chapters/{ch.id}/content", headers=hdr)).json()
    assert r["revision_id"] == published
    assert date.today()  # keep import used

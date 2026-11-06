"""T-06..T-10, T-18..T-24."""

from datetime import timedelta

from sqlalchemy import select

from app.models import AuthorStory
from app.models import Comment, StoryFrame
from app.services.identity import grant_role
from tests.conftest import H, login
from tests.helpers import actor_for, make_work, user_by_tg


async def test_like_idempotent(client, db):
    """T-18."""
    w, _, _ = await make_work(db)
    hdr = H(await login(client, 6001))
    for _ in range(5):
        r = await client.put(f"/api/v1/works/{w.id}/like", headers=hdr)
    assert r.json()["likes"] == 1
    r = await client.delete(f"/api/v1/works/{w.id}/like", headers=hdr)
    r = await client.delete(f"/api/v1/works/{w.id}/like", headers=hdr)
    assert r.json()["likes"] == 0


async def test_thanks_free_and_idempotent(client, db):
    """T-19, T-20: free, no invoice, one per user/work with reason kept."""
    from app.integrations.telegram import get_telegram

    w, _, _ = await make_work(db)
    hdr = H(await login(client, 6002))
    tg = get_telegram()
    tg.calls.clear()
    for _ in range(3):
        r = await client.put(f"/api/v1/works/{w.id}/thanks", json={"reason": "touched"}, headers=hdr)
    body = r.json()
    assert body["thanks"] == 1 and body["reason"] == "touched" and body["charged"] is False
    assert not [c for c in tg.calls if c[0] in ("createInvoiceLink", "sendInvoice")]
    await client.delete(f"/api/v1/works/{w.id}/thanks", headers=hdr)
    r = await client.put(f"/api/v1/works/{w.id}/thanks", json={"reason": "waiting"}, headers=hdr)
    assert r.json()["thanks"] == 1 and r.json()["reason"] == "waiting"


async def test_comment_retry_same_client_key_and_xss_text(client, db):
    """T-21 (retry does not duplicate) and T-23 (HTML is stored as plain text, never executed)."""
    w, _, _ = await make_work(db)
    hdr = H(await login(client, 6003))
    payload = {"body": "<script>alert(1)</script> Zo'r!", "client_key": "ck-12345678"}
    r1 = await client.post(f"/api/v1/works/{w.id}/comments", json=payload, headers=hdr)
    r2 = await client.post(f"/api/v1/works/{w.id}/comments", json=payload, headers=hdr)
    assert r1.json()["id"] == r2.json()["id"]
    assert r1.json()["body"].startswith("<script>")  # rendered as text by the client (React escapes)
    lst = (await client.get(f"/api/v1/works/{w.id}/comments")).json()["items"]
    assert len(lst) == 1
    r = await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "x" * 2001, "client_key": "ck-23456789"}, headers=hdr)
    assert r.status_code == 422


async def test_chapter_spoiler_hidden_until_read(client, db):
    """T-22."""
    w, chs, _ = await make_work(db, chapters=3, completion="ongoing")
    reader = H(await login(client, 6004))
    other = H(await login(client, 6005))
    await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "Oxirida qotil — bog'bon!", "chapter_id": chs[2].id, "client_key": "spoil-0001"}, headers=reader)
    items = (await client.get(f"/api/v1/works/{w.id}/comments", params={"chapter_id": chs[2].id}, headers=other)).json()["items"]
    assert items[0]["spoiler_hidden"] is True and items[0]["body"] is None
    # explicit reveal by user action
    rv = (await client.get(f"/api/v1/comments/{items[0]['id']}/reveal", headers=other)).json()
    assert rv["body"].startswith("Oxirida")
    # after reading the chapter the text is shown
    await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": chs[2].id, "ratio": 1.0, "sequence": 1, "device_id": "x"}, headers=other)
    items = (await client.get(f"/api/v1/works/{w.id}/comments", params={"chapter_id": chs[2].id}, headers=other)).json()["items"]
    assert items[0]["spoiler_hidden"] is False


async def test_premium_chapter_discussion_needs_access(client, db):
    w, chs, _ = await make_work(db, policy="PREMIUM")
    hdr = H(await login(client, 6006))
    r = await client.get(f"/api/v1/works/{w.id}/comments", params={"chapter_id": chs[0].id}, headers=hdr)
    assert r.status_code == 403 and r.json()["error_code"] == "access_required"
    # general work discussion stays open
    assert (await client.get(f"/api/v1/works/{w.id}/comments", headers=hdr)).status_code == 200


async def test_author_cannot_delete_criticism(client, db):
    """T-24."""
    w, _, _ = await make_work(db, owner_tg=1000)
    critic = H(await login(client, 6007))
    c = (await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "Syujet sust", "client_key": "crit-0001"}, headers=critic)).json()
    author = H(await login(client, 1000))
    r = await client.delete(f"/api/v1/comments/{c['id']}", headers=author)
    assert r.status_code == 403
    r = await client.post(f"/api/v1/comments/{c['id']}/report", json={"reason": "abuse"}, headers=author)
    assert r.status_code == 200
    # moderator hides with reason → audit + moderation action
    r = await client.post("/api/v1/admin/moderation", json={"target_type": "comment", "target_id": c["id"], "action": "hide", "reason": ""}, headers=author)
    assert r.status_code == 422  # reason required


async def test_comment_edit_window(client, db):
    w, _, _ = await make_work(db)
    hdr = H(await login(client, 6008))
    c = (await client.post(f"/api/v1/works/{w.id}/comments", json={"body": "a", "client_key": "edit-0001"}, headers=hdr)).json()
    assert (await client.patch(f"/api/v1/comments/{c['id']}", json={"body": "b"}, headers=hdr)).status_code == 200
    row = await db.get(Comment, c["id"])
    row.created_at -= timedelta(minutes=16)
    await db.commit()
    assert (await client.patch(f"/api/v1/comments/{c['id']}", json={"body": "c"}, headers=hdr)).status_code == 403


async def _author_with_story(client, db, tg=7001, premium_frame=False, chapter_id=None, work_id=None):
    author_hdr = H(await login(client, tg, "Muallif"))
    owner = await actor_for(db, 1000)
    await grant_role(db, owner, await user_by_tg(db, tg), "author")
    await db.commit()
    frames = [{"kind": "text", "text": "Ertaga yangi bob!", "linked_work_id": work_id, "linked_chapter_id": chapter_id, "action_type": "new_chapter" if chapter_id else ""}]
    if premium_frame:
        frames.append({"kind": "text", "text": "Faqat Premium uchun sir", "audience": "premium"})
    r = await client.post("/api/v1/studio/storis", json={"frames": frames}, headers=author_hdr)
    assert r.status_code == 200, r.text
    return author_hdr, r.json()


async def test_story_needs_review_then_visible_and_expires(client, db):
    """T-07 (no Telegram Premium needed), T-08 (expiry enforced by API even without scheduler)."""
    author_hdr, st = await _author_with_story(client, db)
    assert st["status"] == "pending"  # untrusted author → review
    owner = H(await login(client, 1000))
    r = await client.post("/api/v1/admin/moderation", json={"target_type": "story", "target_id": st["id"], "action": "approve", "reason": "ok"}, headers=owner)
    assert r.status_code == 200
    feed = (await client.get("/api/v1/storis/feed")).json()
    assert len(feed) == 1 and feed[0]["unseen"] is True
    s = await db.get(AuthorStory, st["id"])
    await db.refresh(s)
    s.expires_at = s.publish_at  # time passes, scheduler is down
    await db.commit()
    assert (await client.get("/api/v1/storis/feed")).json() == []
    assert (await client.get(f"/api/v1/storis/{st['id']}")).status_code == 404


async def test_story_premium_frame_locked_and_chapter_link(client, db):
    """T-06, T-09."""
    w, chs, _ = await make_work(db, policy="PREMIUM")
    author_hdr, st = await _author_with_story(client, db, premium_frame=True, chapter_id=chs[0].id)
    owner = H(await login(client, 1000))
    await client.post("/api/v1/admin/moderation", json={"target_type": "story", "target_id": st["id"], "action": "approve", "reason": "ok"}, headers=owner)
    free = H(await login(client, 7002))
    story = (await client.get(f"/api/v1/storis/{st['id']}", headers=free)).json()
    teaser, secret = story["frames"]
    assert teaser["locked"] is False and teaser["linked"]["chapter_id"] == chs[0].id
    assert secret["locked"] is True and secret["text"] is None and secret["media_url"] is None
    # following the link: paywall/preview, never full text
    c = (await client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=free)).json()
    assert c["mode"] == "preview"


async def test_story_view_counted_after_2_seconds(client, db):
    author_hdr, st = await _author_with_story(client, db)
    owner = H(await login(client, 1000))
    await client.post("/api/v1/admin/moderation", json={"target_type": "story", "target_id": st["id"], "action": "approve", "reason": "ok"}, headers=owner)
    fid = await db.scalar(select(StoryFrame.id).where(StoryFrame.story_id == st["id"]))
    v = H(await login(client, 7003))
    assert (await client.post(f"/api/v1/storis/{st['id']}/views", json={"frame_id": fid, "dwell_ms": 1500}, headers=v)).json()["counted"] is False
    assert (await client.post(f"/api/v1/storis/{st['id']}/views", json={"frame_id": fid, "dwell_ms": 2500}, headers=v)).json()["counted"] is True
    stats = (await client.get("/api/v1/studio/storis/analytics", headers=author_hdr)).json()
    assert stats[0]["unique_views"] == 1 and stats[0]["small_sample"] is True


async def test_story_highlight_keeps_premium_policy(client, db):
    """T-10."""
    author_hdr, st = await _author_with_story(client, db, premium_frame=True)
    fids = (await db.scalars(select(StoryFrame.id).where(StoryFrame.story_id == st["id"]).order_by(StoryFrame.sort_key))).all()
    h = (await client.post("/api/v1/studio/highlights", json={"title": "Tanlangan", "frame_ids": list(fids)}, headers=author_hdr)).json()
    s = await db.get(AuthorStory, st["id"])
    s.status, s.expires_at = "published", s.created_at  # long expired
    await db.commit()
    free = H(await login(client, 7004))
    data = (await client.get(f"/api/v1/highlights/{h['id']}", headers=free)).json()
    assert len(data["frames"]) == 2 and data["frames"][1]["locked"] is True and data["frames"][1]["text"] is None

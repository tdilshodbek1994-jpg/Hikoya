"""Stage D: branching stories and block-level audio ↔ text sync."""

from __future__ import annotations

from app.models import Chapter, ChapterRevision
from app.services import content as content_svc
from app.services.assets import link_asset, store_upload
from tests.conftest import H, login
from tests.helpers import actor_for, doc, make_work
from tests.integration.test_stage_c import make_mp4


async def _branching_work(db, policy="FREE"):
    owner = await actor_for(db, 1000)
    w = await content_svc.create_work(db, owner, title="Yo'l ayrilishi", synopsis="", access_policy=policy)
    start = await content_svc.add_chapter(db, owner, w, title="Boshlanish", doc=doc("Eshik oldida ikki yo'l bor edi."))
    left = await content_svc.add_chapter(db, owner, w, title="Chap yo'l", doc=doc("CHAP o'rmon qorong'i edi."))
    right = await content_svc.add_chapter(db, owner, w, title="O'ng yo'l", doc=doc("ONG daryo shovqini eshitildi."))
    if policy != "FREE":
        await content_svc.update_chapter_meta(db, owner, start, {"access_override": "free_sample"})
        await content_svc.update_chapter_meta(db, owner, left, {"access_override": "free_sample"})
    await content_svc.publish_now(db, owner, w)
    await db.commit()
    return w, start, left, right


async def test_author_sets_choices_and_reader_follows_branch(client, db):
    w, start, left, right = await _branching_work(db)
    ohdr = H(await login(client, 1000))
    r = await client.put(f"/api/v1/studio/chapters/{start.id}/choices", json={"items": [{"label": "Chapga burilish", "target_chapter_id": left.id}, {"label": "O'ngga yurish", "target_chapter_id": right.id}]}, headers=ohdr)
    assert r.status_code == 200, r.text
    assert [c["label"] for c in r.json()["items"]] == ["Chapga burilish", "O'ngga yurish"]
    # invalid targets
    other, ochs, _ = await make_work(db, title="Boshqa")
    bad = await client.put(f"/api/v1/studio/chapters/{start.id}/choices", json={"items": [{"label": "x", "target_chapter_id": ochs[0].id}]}, headers=ohdr)
    assert bad.status_code == 422 and bad.json()["error_code"] == "target_invalid"
    self_ = await client.put(f"/api/v1/studio/chapters/{start.id}/choices", json={"items": [{"label": "x", "target_chapter_id": start.id}]}, headers=ohdr)
    assert self_.status_code == 422
    stranger = H(await login(client, 8500))
    assert (await client.put(f"/api/v1/studio/chapters/{start.id}/choices", json={"items": []}, headers=stranger)).status_code == 404

    hdr = H(await login(client, 8501))
    body = (await client.get(f"/api/v1/chapters/{start.id}/content", headers=hdr)).json()
    choices = body["choices"]
    assert [c["label"] for c in choices] == ["Chapga burilish", "O'ngga yurish"]
    assert all(c["percent"] is None and not c["chosen"] for c in choices)  # no crowd numbers before deciding
    r = await client.post(f"/api/v1/chapters/{start.id}/choices/{choices[1]['id']}", headers=hdr)
    assert r.json() == {"target_chapter_id": right.id, "locked": False}
    body = (await client.get(f"/api/v1/chapters/{start.id}/content", headers=hdr)).json()
    assert body["choices"][1]["chosen"] and body["choices"][1]["percent"] == 100 and body["choices"][0]["percent"] == 0
    # change of mind is allowed (one pick per chapter)
    await client.post(f"/api/v1/chapters/{start.id}/choices/{choices[0]['id']}", headers=hdr)
    picks = (await client.get(f"/api/v1/studio/chapters/{start.id}/choices", headers=ohdr)).json()["items"]
    assert [p["picks"] for p in picks] == [1, 0]
    # a choice id from another chapter is rejected
    assert (await client.post(f"/api/v1/chapters/{left.id}/choices/{choices[0]['id']}", headers=hdr)).status_code == 404
    # editing labels keeps ids (and the reader's pick)
    r = await client.put(f"/api/v1/studio/chapters/{start.id}/choices", json={"items": [{"label": "Chap tomonga", "target_chapter_id": left.id}, {"label": "O'ngga yurish", "target_chapter_id": right.id}]}, headers=ohdr)
    assert r.json()["items"][0]["id"] == choices[0]["id"] and r.json()["items"][0]["picks"] == 1


async def test_locked_branch_is_marked_not_opened_and_reads_count_by_completion(client, db):
    w, start, left, right = await _branching_work(db, policy="PREMIUM")
    ohdr = H(await login(client, 1000))
    await client.put(f"/api/v1/studio/chapters/{start.id}/choices", json={"items": [{"label": "Chap", "target_chapter_id": left.id}, {"label": "O'ng", "target_chapter_id": right.id}]}, headers=ohdr)
    hdr = H(await login(client, 8502))
    ch = (await client.get(f"/api/v1/chapters/{start.id}/content", headers=hdr)).json()
    assert [c["locked"] for c in ch["choices"]] == [False, True]
    r = await client.post(f"/api/v1/chapters/{start.id}/choices/{ch['choices'][1]['id']}", headers=hdr)
    assert r.json()["locked"] is True
    assert (await client.get(f"/api/v1/chapters/{right.id}/content", headers=hdr)).json()["mode"] == "preview"
    # a character revealed on the right branch stays hidden for someone who read only the left branch
    await client.post(f"/api/v1/studio/works/{w.id}/characters", json={"name": "Daryo qo'riqchisi", "reveal_chapter_id": right.id}, headers=ohdr)
    await client.put("/api/v1/reading/progress", json={"work_id": w.id, "chapter_id": left.id, "ratio": 1.0, "sequence": 1, "device_id": "d"}, headers=hdr)
    chars = (await client.get(f"/api/v1/works/{w.id}/characters", headers=hdr)).json()
    assert chars["items"] == [] and chars["hidden_count"] == 1


async def test_audio_sync_marks_validated_and_served_to_reader(client, db):
    w, chs, owner = await make_work(db, paras=6)
    ch = chs[0]
    audio = await store_upload(db, owner.id, b"\0\0\0\x18ftypM4A " + make_mp4(30)[16:], "bob.m4a")
    await link_asset(db, audio, "chapter", ch.id, "audio")
    c = await db.get(Chapter, ch.id)
    c.has_audio = True
    await db.commit()
    rev = await db.get(ChapterRevision, c.published_revision_id)
    bids = rev.block_ids
    ohdr = H(await login(client, 1000))
    g = (await client.get(f"/api/v1/studio/chapters/{ch.id}/audio-sync", headers=ohdr)).json()
    assert g["audio_url"] and len(g["blocks"]) == 6 and g["marks"] == []
    bad = await client.put(f"/api/v1/studio/chapters/{ch.id}/audio-sync", json={"marks": [{"bid": bids[0], "t": 10}, {"bid": bids[1], "t": 2}]}, headers=ohdr)
    assert bad.status_code == 422 and bad.json()["error_code"] == "sync_order"
    unknown = await client.put(f"/api/v1/studio/chapters/{ch.id}/audio-sync", json={"marks": [{"bid": "zzzzzzzz", "t": 1}]}, headers=ohdr)
    assert unknown.json()["error_code"] == "block_not_found"
    ok = await client.put(f"/api/v1/studio/chapters/{ch.id}/audio-sync", json={"marks": [{"bid": bids[2], "t": 9.5}, {"bid": bids[0], "t": 0}, {"bid": bids[1], "t": 4.25}]}, headers=ohdr)
    assert ok.status_code == 200
    assert [m["bid"] for m in ok.json()["marks"]] == bids[:3]
    reader = H(await login(client, 8510))
    body = (await client.get(f"/api/v1/chapters/{ch.id}/content", headers=reader)).json()
    assert body["audio"]["sync"] == [{"bid": bids[0], "t": 0.0}, {"bid": bids[1], "t": 4.25}, {"bid": bids[2], "t": 9.5}]
    stranger = H(await login(client, 8511))
    assert (await client.put(f"/api/v1/studio/chapters/{ch.id}/audio-sync", json={"marks": []}, headers=stranger)).status_code == 404


async def test_interface_language_preference(client, db):
    hdr = H(await login(client, 8520))
    r = await client.patch("/api/v1/me/preferences", json={"language": "ru"}, headers=hdr)
    assert r.status_code == 200
    assert (await client.get("/api/v1/me", headers=hdr)).json()["language"] == "ru"
    assert (await client.patch("/api/v1/me/preferences", json={"language": "de"}, headers=hdr)).status_code == 422

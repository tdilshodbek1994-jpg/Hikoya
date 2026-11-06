"""T-28 … T-37, T-55 … T-57 and the stage-A criterion (admin adds via bot → reader finds and reads)."""

import io
import time
from datetime import timedelta

from sqlalchemy import func, select

from app.bot.dispatcher import process_update
from app.core.timeutil import utcnow
from app.integrations.telegram import TelegramError, get_telegram
from app.models import BotDialog, Chapter, Delivery, Notification, PublishJob, User, Work
from app.services import content as svc
from app.services.identity import grant_role
from app.workers.__main__ import deliver, process_outbox, run_due_publish_jobs
from tests.conftest import H, login
from tests.helpers import actor_for, doc, make_work, user_by_tg

_n = [0]


def uid() -> int:
    _n[0] += 1
    return int(time.time()) * 1000 + _n[0]


def msg(tg: int, text: str | None = None, **extra) -> dict:
    m = {"message_id": 1, "chat": {"id": tg, "type": "private"}, "from": {"id": tg, "first_name": "Adm"}, **extra}
    if text is not None:
        m["text"] = text
    return {"update_id": uid(), "message": m}


def cbq(tg: int, data: str) -> dict:
    return {"update_id": uid(), "callback_query": {"id": str(uid()), "from": {"id": tg, "first_name": "Adm"}, "message": {"chat": {"id": tg}}, "data": data}}


def last_texts(n: int = 3) -> list[str]:
    return [c[1]["text"] for c in get_telegram().calls if c[0] == "sendMessage"][-n:]


async def test_bot_add_story_end_to_end_with_restart(client, db):
    """Stage A criterion + T-28: the wizard state survives a restart (it lives in the DB)."""
    owner = 1000
    await process_update(msg(owner, "/start"))
    await process_update(msg(owner, "/new_work"))
    await process_update(cbq(owner, "nw:kind:short"))
    await process_update(msg(owner, "Bog'dagi chiroq"))
    await process_update(msg(owner, "Bir oqshom hovlida yonib qolgan chiroq haqida."))
    await process_update(cbq(owner, "nw:author:me"))
    gid = (await client.get("/api/v1/genres")).json()[0]["id"]
    await process_update(cbq(owner, f"nw:g:{gid}"))
    await process_update(cbq(owner, "nw:gx:done"))
    await process_update(cbq(owner, "nw:comp:completed"))
    await process_update(cbq(owner, "nw:classify:done"))
    await process_update(cbq(owner, "nw:skip"))  # cover later
    await process_update(msg(owner, "Birinchi paragraf. " * 40))
    # --- simulated restart: nothing in memory survives, state is read from bot_dialogs ---
    from app.integrations import telegram as tgmod

    tgmod.reset_telegram()
    d = await db.get(BotDialog, (await user_by_tg(db, owner)).id)
    await db.refresh(d)
    assert d.flow == "new_work" and d.step == "text" and len(d.data["text_parts"]) == 1
    await process_update(msg(owner, "/start"))
    assert "tugallanmagan jarayon" in last_texts(1)[0]
    await process_update(cbq(owner, "x:resume"))
    await process_update(msg(owner, "Ikkinchi paragraf. " * 40))
    await process_update(cbq(owner, "nw:textdone"))
    await process_update(cbq(owner, "nw:skip"))  # no files
    await process_update(cbq(owner, "nw:acc:FREE"))
    await process_update(cbq(owner, "nw:fin:publish"))
    assert any("Nashr qilindi" in t for t in last_texts(2))
    # reader finds it, reads it and continues
    hdr = H(await login(client, 9101))
    items = (await client.get("/api/v1/search", params={"q": "bog'dagi chiroq"})).json()["items"]
    assert len(items) == 1
    work = (await client.get(f"/api/v1/works/{items[0]['code']}", headers=hdr)).json()
    ch_id = work["toc"][0]["id"]
    c = (await client.get(f"/api/v1/chapters/{ch_id}/content", headers=hdr)).json()
    assert c["mode"] == "full" and "Ikkinchi paragraf" in str(c["content"])
    bid = c["content"]["content"][0]["attrs"]["bid"]
    await client.put("/api/v1/reading/progress", json={"work_id": work["id"], "chapter_id": ch_id, "block_id": bid, "ratio": 0.4, "sequence": 1, "device_id": "p"}, headers=hdr)
    assert (await client.get(f"/api/v1/works/{work['code']}", headers=hdr)).json()["start_action"] == "continue"


async def test_bot_docx_import_and_duplicate(client, db):
    """T-29: the same DOCX twice → warned, not silently duplicated."""
    import docx

    d = docx.Document()
    d.add_heading("1-bob. Boshlanish", level=1)
    d.add_paragraph("Birinchi bob matni. " * 30)
    d.add_heading("2-bob. Davomi", level=1)
    d.add_paragraph("Ikkinchi bob matni. " * 30)
    buf = io.BytesIO()
    d.save(buf)
    data = buf.getvalue()
    owner = 1000
    tg = get_telegram()
    tg.file_bytes = {"F1": data}
    await process_update(msg(owner, "/new_work"))
    await process_update(cbq(owner, "nw:kind:novel"))
    await process_update(msg(owner, "Import sinovi"))
    await process_update(cbq(owner, "nw:skip"))
    await process_update(cbq(owner, "nw:author:me"))
    dlg = await db.get(BotDialog, (await user_by_tg(db, owner)).id)
    await db.refresh(dlg)
    dlg.step = "text"
    await db.commit()
    await process_update(msg(owner, document={"file_id": "F1", "file_name": "roman.docx", "file_size": len(data)}))
    assert "2 ta bob" in " ".join(last_texts(2))
    await db.refresh(dlg)
    work_id = dlg.active_work_id
    dlg.step = "text"
    await db.commit()
    await process_update(msg(owner, document={"file_id": "F1", "file_name": "roman.docx", "file_size": len(data)}))
    assert "allaqachon import" in " ".join(last_texts(2))
    n = await db.scalar(select(func.count()).select_from(Chapter).where(Chapter.work_id == work_id))
    assert n == 2


async def test_broken_import_keeps_published_text(client, db):
    """T-30."""
    from app.services.assets import store_upload
    from app.services.importer import start_import

    w, chs, owner = await make_work(db)
    published = chs[0].published_revision_id
    bad = b"PK\x03\x04" + b"\x00" * 100
    try:
        await store_upload(db, owner.id, bad, "buzuq.docx")
        raise AssertionError("must fail")
    except Exception as e:
        assert "buzilgan" in str(e) or "DOCX" in str(e)
    ch = await db.get(Chapter, chs[0].id)
    await db.refresh(ch)
    assert ch.published_revision_id == published
    assert start_import  # imported for completeness


async def test_concurrent_save_conflict(client, db):
    """T-32."""
    w, chs, owner = await make_work(db, owner_tg=1000)
    hdr = H(await login(client, 1000))
    ed = (await client.get(f"/api/v1/studio/chapters/{chs[0].id}", headers=hdr)).json()
    base = ed["base_revision_id"]
    a = await client.post(f"/api/v1/studio/chapters/{chs[0].id}/revisions", json={"content": doc("Muharrir A"), "base_revision_id": base}, headers=hdr)
    b = await client.post(f"/api/v1/studio/chapters/{chs[0].id}/revisions", json={"content": doc("Muharrir B"), "base_revision_id": base}, headers=hdr)
    assert a.status_code == 200 and b.status_code == 409
    assert b.json()["current_revision_id"] == a.json()["revision_id"]


async def test_restore_old_revision_keeps_history(client, db):
    """T-33."""
    w, chs, owner = await make_work(db, owner_tg=1000)
    hdr = H(await login(client, 1000))
    ch = await db.get(Chapter, chs[0].id)
    first = ch.published_revision_id
    await svc.save_revision(db, owner, ch, doc("Yangi versiya"), first)
    await svc.publish_now(db, owner, await db.get(Work, w.id))
    await db.commit()
    r = await client.post(f"/api/v1/studio/chapters/{ch.id}/restore", json={"revision_id": first, "publish": True}, headers=hdr)
    assert r.status_code == 200
    revs = (await client.get(f"/api/v1/studio/chapters/{ch.id}/revisions", headers=hdr)).json()
    assert len(revs) == 3 and revs[0]["published"]
    reader = H(await login(client, 9102))
    c = (await client.get(f"/api/v1/chapters/{ch.id}/content", headers=reader)).json()
    assert "Yangi versiya" not in str(c["content"])
    audit = (await client.get("/api/v1/studio/audit", params={"target_type": "chapter", "target_id": str(ch.id)}, headers=hdr)).json()
    assert any(a["action"] == "chapter.restore_revision" for a in audit)
    diff = (await client.get(f"/api/v1/studio/revisions/{revs[1]['id']}/diff", params={"against": first}, headers=hdr)).json()
    assert diff["changes"]


async def test_publish_job_once_and_reschedule(client, db):
    """T-34, T-35."""
    w, chs, owner = await make_work(db, publish=False)
    ch = await db.get(Chapter, chs[0].id)
    job1 = await svc.schedule_publish(db, owner, ch, utcnow() + timedelta(hours=1))
    job2 = await svc.schedule_publish(db, owner, ch, utcnow() + timedelta(hours=2))
    await db.commit()
    await db.refresh(job1)
    assert job1.status == "canceled" and job2.job_version == 2
    j = await db.get(PublishJob, job2.id)
    j.run_at = utcnow() - timedelta(seconds=1)
    await db.commit()
    import asyncio

    results = await asyncio.gather(run_due_publish_jobs(), run_due_publish_jobs())
    assert sum(results) == 1
    from app.models import OutboxEvent

    n = await db.scalar(select(func.count()).select_from(OutboxEvent).where(OutboxEvent.type == "chapter.published"))
    assert n == 1


async def test_other_authors_draft_is_invisible(client, db):
    """T-36."""
    owner = await actor_for(db, 1000)
    for tg in (9201, 9202):
        await actor_for(db, tg)
        await grant_role(db, owner, await user_by_tg(db, tg), "author")
    await db.commit()
    a_hdr = H(await login(client, 9201))
    b_hdr = H(await login(client, 9202))
    w = (await client.post("/api/v1/studio/works", json={"title": "A ning qoralamasi"}, headers=a_hdr)).json()
    ch = (await client.post(f"/api/v1/studio/works/{w['id']}/chapters", json={"text": "maxfiy matn"}, headers=a_hdr)).json()
    for url in (f"/api/v1/studio/works/{w['id']}", f"/api/v1/studio/chapters/{ch['id']}", f"/api/v1/studio/chapters/{ch['id']}/preview", f"/api/v1/studio/works/{w['id']}/stats", f"/api/v1/studio/revisions/{ch['draft_revision_id']}"):
        r = await client.get(url, headers=b_hdr)
        assert r.status_code == 404, url
        assert "maxfiy" not in r.text
    assert (await client.get(f"/api/v1/chapters/{ch['id']}/content", headers=b_hdr)).status_code == 404


async def test_role_revoked_while_editor_open(client, db):
    """T-37."""
    owner = await actor_for(db, 1000)
    w, chs, _ = await make_work(db, owner_tg=1000)
    await actor_for(db, 9301)
    editor = await user_by_tg(db, 9301)
    await grant_role(db, owner, editor, "editor", "work", w.id)
    await db.commit()
    hdr = H(await login(client, 9301))
    ed = (await client.get(f"/api/v1/studio/chapters/{chs[0].id}", headers=hdr)).json()
    owner_hdr = H(await login(client, 1000))
    await client.delete("/api/v1/admin/roles", params={"user_ref": str(editor.telegram_user_id), "role": "editor"}, headers=owner_hdr)
    r = await client.post(f"/api/v1/studio/chapters/{chs[0].id}/revisions", json={"content": doc("x"), "base_revision_id": ed["base_revision_id"]}, headers=hdr)
    assert r.status_code == 404
    # old bot button no longer works either
    await process_update(cbq(9301, f"w:{w.id}:pubask"))
    assert "topilmadi" in last_texts(1)[0].lower()


async def test_bot_consent_refused_reader_still_works(client, db):
    """T-55."""
    w, chs, _ = await make_work(db)
    await process_outbox()  # the first publish happened before this reader existed
    await process_update(msg(9401, "/start"))
    await process_update(cbq(9401, "m:consent:0"))
    u = await user_by_tg(db, 9401)
    await db.refresh(u)
    assert u.bot_messages_allowed is False
    hdr = H(await login(client, 9401))
    assert (await client.get(f"/api/v1/chapters/{chs[0].id}/content", headers=hdr)).json()["mode"] == "full"
    assert (await client.put(f"/api/v1/works/{w.id}/like", headers=hdr)).status_code == 200
    # an in-app notification is still created, but no Telegram delivery
    await client.put(f"/api/v1/works/{w.id}/follow", headers=hdr)
    owner = await actor_for(db, 1000)
    work = await db.get(Work, w.id)
    await svc.add_chapter(db, owner, work, title="2-bob", doc=doc("davomi " * 50))
    await svc.publish_now(db, owner, work)
    await db.commit()
    await process_outbox()
    assert await db.scalar(select(func.count()).select_from(Notification).where(Notification.user_id == u.id)) == 1
    assert await db.scalar(select(func.count()).select_from(Delivery).where(Delivery.user_id == u.id)) == 0


async def _reader_following(db, tg: int, works: list, mode: str):
    from app.models import Follow, NotificationPreference

    await actor_for(db, tg)
    u = await user_by_tg(db, tg)
    u.bot_started = True
    u.bot_messages_allowed = True
    prefs = await db.get(NotificationPreference, u.id)
    prefs.mode = mode
    prefs.quiet_start = prefs.quiet_end = "00:00"  # no quiet hours for the test
    for w in works:
        db.add(Follow(user_id=u.id, target_type="work", target_id=w.id))
    await db.commit()
    return u


async def test_five_new_chapters_grouped_digest(client, db):
    """T-56."""
    works = [(await make_work(db, title=f"Asar {i}", completion="ongoing"))[0] for i in range(5)]
    await process_outbox()
    u = await _reader_following(db, 9501, works, "instant")
    owner = await actor_for(db, 1000)
    for w in works:
        work = await db.get(Work, w.id)
        await svc.add_chapter(db, owner, work, title="Yangi bob", doc=doc("matn " * 40))
        await svc.publish_now(db, owner, work)
    await db.commit()
    await process_outbox()
    tg = get_telegram()
    tg.calls.clear()
    await deliver()
    sent = [c for c in tg.calls if c[0] == "sendMessage" and c[1]["chat_id"] == u.telegram_user_id]
    assert len(sent) == 1 and sent[0][1]["text"].count("•") == 5


async def test_telegram_429_and_blocked(client, db):
    """T-57."""
    w, _, _ = await make_work(db, completion="ongoing")
    await process_outbox()
    u = await _reader_following(db, 9601, [w], "instant")
    owner = await actor_for(db, 1000)
    work = await db.get(Work, w.id)
    await svc.add_chapter(db, owner, work, title="2", doc=doc("matn " * 40))
    await svc.publish_now(db, owner, work)
    await db.commit()
    await process_outbox()
    tg = get_telegram()
    tg.fake_hook = lambda m, p: TelegramError(429, "Too Many Requests", 17) if m == "sendMessage" else None
    await deliver()
    d = await db.scalar(select(Delivery).where(Delivery.user_id == u.id))
    await db.refresh(d)
    assert d.status == "pending" and d.next_attempt_at > utcnow() + timedelta(seconds=10)
    d.next_attempt_at = utcnow()
    await db.commit()
    tg.fake_hook = lambda m, p: TelegramError(403, "Forbidden: bot was blocked by the user") if m == "sendMessage" else None
    await deliver()
    await db.refresh(d)
    user = await db.get(User, u.id)
    await db.refresh(user)
    assert d.status == "failed" and user.bot_blocked is True
    tg.calls.clear()
    await deliver()
    assert not [c for c in tg.calls if c[0] == "sendMessage"]


async def test_bot_menu_by_permissions(client, db):
    """Hidden buttons are not the check: a reader calling an admin callback is refused."""
    await process_update(msg(9701, "/admin"))
    assert "xodimlar va mualliflar" in last_texts(1)[0]
    await process_update(cbq(9701, "a:billing"))
    assert "vakolat" in last_texts(1)[0].lower()
    await process_update(msg(1000, "/admin"))
    calls = [c for c in get_telegram().calls if c[0] == "sendMessage"]
    kb = str(calls[-1][1]["reply_markup"])
    assert "Premium va to'lovlar" in kb and "Xodimlar" in kb

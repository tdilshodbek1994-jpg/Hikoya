"""Sharing: prepared message cards, story card, deep-link attribution, inline mode."""

from sqlalchemy import select

from app.bot.dispatcher import process_update
from app.integrations.telegram import TelegramError, get_telegram
from app.models import Referral, ShareLink
from app.services.sharing import split_param
from tests.conftest import H, init_data_for, login
from tests.helpers import make_work, user_by_tg
from tests.integration.test_billing import next_update_id


def test_split_param():
    assert split_param("w_abc__s12") == ("w_abc", 12)
    assert split_param("w_abc") == ("w_abc", None)
    assert split_param("c_5__sX") == ("c_5__sX", None)


async def test_prepare_message_card_and_reuse(client, db):
    w, chs, _ = await make_work(db, title="Kuzgi bog'")
    hdr = H(await login(client, 8800))
    r = await client.post("/api/v1/share/prepare", json={"target_type": "work", "target_id": w.id, "channel": "message"}, headers=hdr)
    assert r.status_code == 200, r.text
    d = r.json()
    assert f"startapp=w_{w.short_code}__s{d['share_id']}" in d["link"]
    assert d["image_url"].endswith(".jpg") and d["prepared_message_id"]
    method, params = next(c for c in get_telegram().calls if c[0] == "savePreparedInlineMessage")
    res = params["result"]
    assert res["type"] == "photo" and res["photo_url"] == d["image_url"]
    assert res["reply_markup"]["inline_keyboard"][0][0]["url"] == d["link"]
    assert "Kuzgi bog" in res["caption"] and params["allow_bot_chats"] is False
    again = (await client.post("/api/v1/share/prepare", json={"target_type": "work", "target_id": w.id, "channel": "message"}, headers=hdr)).json()
    assert again["share_id"] == d["share_id"]  # repeated taps reuse one row
    story = (await client.post("/api/v1/share/prepare", json={"target_type": "work", "target_id": w.id, "channel": "story"}, headers=hdr)).json()
    assert story["share_id"] != d["share_id"] and story["image_url"] != d["image_url"] and story["prepared_message_id"] is None
    from app.integrations.storage import get_storage

    jpg = await get_storage().get("share/" + story["image_url"].split("/share/")[1], True)
    assert jpg[:3] == b"\xff\xd8\xff"


async def test_prepare_falls_back_when_telegram_unreachable(client, db):
    w, chs, _ = await make_work(db)
    get_telegram().fake_hook = lambda m, p: TelegramError(400, "Bad Request") if m == "savePreparedInlineMessage" else None
    hdr = H(await login(client, 8801))
    d = (await client.post("/api/v1/share/prepare", json={"target_type": "work", "target_id": w.id, "channel": "message"}, headers=hdr)).json()
    assert d["prepared_message_id"] is None and "startapp=" in d["link"]


async def test_drafts_cannot_be_shared(client, db):
    w, chs, _ = await make_work(db, publish=False)
    hdr = H(await login(client, 8802))
    assert (await client.post("/api/v1/share/prepare", json={"target_type": "work", "target_id": w.id}, headers=hdr)).status_code == 404
    assert (await client.post("/api/v1/share/prepare", json={"target_type": "chapter", "target_id": chs[0].id}, headers=hdr)).status_code == 404


async def test_open_counted_once_and_new_user_becomes_referral(client, db):
    w, chs, _ = await make_work(db)
    sharer = H(await login(client, 8810))
    d = (await client.post("/api/v1/share/prepare", json={"target_type": "work", "target_id": w.id, "channel": "link"}, headers=sharer)).json()
    param = d["link"].split("startapp=")[1]
    for _ in range(2):  # same newcomer opens twice
        r = await client.post("/api/v1/auth/telegram", json={"init_data": init_data_for(8811, "Yangi", start_param=param)})
        assert r.status_code == 200
    await client.post("/api/v1/auth/telegram", json={"init_data": init_data_for(8810, "Men", start_param=param)})  # own link
    sl = await db.get(ShareLink, d["share_id"])
    await db.refresh(sl)
    assert sl.opens == 1 and sl.new_users == 1
    newcomer = await user_by_tg(db, 8811)
    sharer_user = await user_by_tg(db, 8810)
    assert (await db.get(Referral, newcomer.id)).referrer_user_id == sharer_user.id
    stats = (await client.get("/api/v1/me/shares", headers=sharer)).json()
    assert {k: stats[k] for k in ("shares", "opens", "new_users")} == {"shares": 1, "opens": 1, "new_users": 1}
    ohdr = H(await login(client, 1000))
    ws = (await client.get(f"/api/v1/studio/works/{w.id}/shares", headers=ohdr)).json()
    assert ws["by_channel"] == [{"channel": "link", "shares": 1, "opens": 1, "new_users": 1}]


async def test_inline_mode_returns_cards(client, db):
    w, chs, _ = await make_work(db, title="Qorli tun")
    await make_work(db, title="Boshqa narsa", publish=False)
    upd = {"update_id": next_update_id(), "inline_query": {"id": "iq1", "from": {"id": 8820, "first_name": "I"}, "query": "qorli", "offset": ""}}
    r = await process_update(upd)
    assert r["status"] == "ok"
    method, params = next(c for c in get_telegram().calls if c[0] == "answerInlineQuery")
    assert params["inline_query_id"] == "iq1" and params["is_personal"] is True
    titles = [x["title"] for x in params["results"]]
    assert titles == ["Qorli tun"]
    url = params["results"][0]["reply_markup"]["inline_keyboard"][0][0]["url"]
    assert f"startapp=w_{w.short_code}__s" in url
    sl = await db.scalar(select(ShareLink).where(ShareLink.channel == "inline"))
    assert sl is not None and sl.target_id == w.id
    # empty query → popular public works only
    get_telegram().calls.clear()
    await process_update({"update_id": next_update_id(), "inline_query": {"id": "iq2", "from": {"id": 8820}, "query": "", "offset": ""}})
    _, params = next(c for c in get_telegram().calls if c[0] == "answerInlineQuery")
    assert "Boshqa narsa" not in [x["title"] for x in params["results"]]

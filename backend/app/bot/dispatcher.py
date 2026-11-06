"""Raw Telegram update dispatcher (webhook and polling share it).

1. the update is claimed by update_id in its own transaction (duplicates are dropped);
2. payment updates (pre_checkout_query, successful_payment, refunded_payment, subscription) go
   straight to the billing service — never behind media processing;
3. everything else goes to bot flows; replies are sent after the transaction commits.
Payment update payloads are stored so a failed processing run can be retried by the worker.
"""

from __future__ import annotations

import logging

from sqlalchemy import select, update

from app.bot import flows
from app.bot.ui import Reply
from app.config import get_settings
from app.core.errors import AppError
from app.core.timeutil import utcnow
from app.db import sessionmaker
from app.integrations.telegram import TelegramError, get_telegram
from app.models import TelegramUpdate, User
from app.services import billing
from app.services.identity import get_or_create_user_by_tg, load_actor

log = logging.getLogger("hikoya.bot")

PAYMENT_KINDS = {"pre_checkout_query", "successful_payment", "refunded_payment", "subscription"}
ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "pre_checkout_query", "my_chat_member", "purchased_paid_media", "subscription"]


def update_kind(u: dict) -> str:
    if "pre_checkout_query" in u:
        return "pre_checkout_query"
    if "subscription" in u:
        return "subscription"
    m = u.get("message") or {}
    if "successful_payment" in m:
        return "successful_payment"
    if "refunded_payment" in m:
        return "refunded_payment"
    for k in ("callback_query", "edited_message", "my_chat_member", "message"):
        if k in u:
            return k
    return "other"


async def process_update(u: dict) -> dict:
    uid = int(u.get("update_id", 0))
    kind = update_kind(u)
    async with sessionmaker()() as db:
        fresh = await billing.claim_update(db, uid, kind, u if kind in PAYMENT_KINDS else None)
        await db.commit()
    if not fresh:
        return {"status": "duplicate"}
    replies: list[tuple[int, Reply]] = []
    after: list[tuple[str, dict]] = []
    try:
        async with sessionmaker()() as db:
            replies, after = await _route(db, u, kind)
            await db.execute(update(TelegramUpdate).where(TelegramUpdate.update_id == uid).values(processed_at=utcnow()))
            await db.commit()
    except Exception as e:  # recorded; payment kinds are retried by the worker
        log.exception("update %s failed", uid)
        async with sessionmaker()() as db:
            await db.execute(update(TelegramUpdate).where(TelegramUpdate.update_id == uid).values(error=str(e)[:500]))
            await db.commit()
        if kind == "pre_checkout_query":
            q = u["pre_checkout_query"]
            await _safe_call("answerPreCheckoutQuery", pre_checkout_query_id=q["id"], ok=False, error_message="Vaqtinchalik xato, qayta urinib ko'ring")
        return {"status": "error"}
    for method, params in after:
        await _safe_call(method, **params)
    for chat_id, r in replies:
        await send_reply(chat_id, r)
    return {"status": "ok", "replies": len(replies)}


async def retry_failed_payment_updates(limit: int = 20) -> int:
    """Recovery: payment updates that were stored but not processed (e.g. DB hiccup)."""
    async with sessionmaker()() as db:
        rows = (
            await db.scalars(
                select(TelegramUpdate).where(TelegramUpdate.processed_at.is_(None), TelegramUpdate.kind.in_(("successful_payment", "refunded_payment", "subscription")), TelegramUpdate.payload.is_not(None)).limit(limit)
            )
        ).all()
        items = [(r.update_id, r.kind, r.payload) for r in rows]
    done = 0
    for uid, kind, payload in items:
        try:
            async with sessionmaker()() as db:
                await _route(db, payload, kind)
                await db.execute(update(TelegramUpdate).where(TelegramUpdate.update_id == uid).values(processed_at=utcnow(), error=""))
                await db.commit()
                done += 1
        except Exception as e:
            log.warning("retry %s failed: %s", uid, e)
    return done


async def _safe_call(method: str, **params) -> None:
    try:
        await get_telegram().call(method, **params)
    except TelegramError as e:
        log.warning("%s failed: %s", method, e)
    except Exception as e:
        log.warning("%s failed: %s", method, e)


async def send_reply(chat_id: int, r: Reply) -> None:
    tg = get_telegram()
    try:
        await tg.call("sendMessage", chat_id=chat_id, text=r.text[:4096], parse_mode="HTML", reply_markup=r.markup(), link_preview_options={"is_disabled": True})
    except TelegramError as e:
        if e.blocked:
            async with sessionmaker()() as db:
                await db.execute(update(User).where(User.telegram_user_id == chat_id).values(bot_blocked=True))
                await db.commit()
        log.warning("sendMessage failed: %s", e)


async def _download(file_id: str, size: int | None) -> bytes:
    s = get_settings()
    if size and size > s.limit_bot_file_mib * 1024 * 1024:
        raise AppError(f"Fayl {s.limit_bot_file_mib} MiB dan katta. Katta fayllarni ilovadagi yuklash oynasidan yuboring.", code="file_too_large")
    tg = get_telegram()
    info = await tg.call("getFile", file_id=file_id)
    path = info.get("file_path") if isinstance(info, dict) else None
    if not path:
        raise AppError("Faylni olib bo'lmadi", code="file_unavailable")
    if not tg.enabled:
        hook = getattr(tg, "file_bytes", {})
        return hook.get(file_id, b"")
    import httpx

    async with httpx.AsyncClient(timeout=60, proxy=s.telegram_proxy or None) as c:
        test = "/test" if s.telegram_test_env else ""
        r = await c.get(f"{s.telegram_api_base}/file/bot{s.bot_token}{test}/{path}")
        r.raise_for_status()
        return r.content


async def _route(db, u: dict, kind: str) -> tuple[list[tuple[int, Reply]], list[tuple[str, dict]]]:
    after: list[tuple[str, dict]] = []
    if kind == "pre_checkout_query":
        q = u["pre_checkout_query"]
        ok, err = await billing.handle_pre_checkout(db, q)
        params = {"pre_checkout_query_id": q["id"], "ok": ok}
        if not ok:
            params["error_message"] = err
        # answered right after this light transaction commits (well within 10 s)
        return [], [("answerPreCheckoutQuery", params)]
    if kind == "subscription":
        await billing.handle_subscription_update(db, u["subscription"], int(u["update_id"]))
        return [], []
    if kind == "successful_payment":
        m = u["message"]
        pay = await billing.handle_successful_payment(db, int(m["from"]["id"]), m["successful_payment"])
        text = "✅ To'lov tasdiqlandi. Premium ochildi — ilovaga qayting." if pay and pay.state == "confirmed" else "To'lov qabul qilindi, tekshirilmoqda. Savol bo'lsa: /paysupport"
        return [(m["chat"]["id"], Reply(text, [[{"text": "📖 Ilovani ochish", "web_app": {"url": get_settings().webapp_url}}]]))], []
    if kind == "refunded_payment":
        await billing.handle_refunded_payment(db, u["message"]["refunded_payment"])
        return [], []
    if kind == "my_chat_member":
        m = u["my_chat_member"]
        status = (m.get("new_chat_member") or {}).get("status")
        user = await db.scalar(select(User).where(User.telegram_user_id == int(m["from"]["id"])))
        if user:
            user.bot_blocked = status in ("kicked",)
        return [], []
    if kind == "edited_message":
        m = u["edited_message"]
        return [(m["chat"]["id"], flows.Reply("Tahrirlangan xabar nashr qilingan matnga avtomatik qo'llanmaydi. Matnni ustaxonada tahrirlang."))], []
    if kind == "callback_query":
        q = u["callback_query"]
        frm = q["from"]
        user = await get_or_create_user_by_tg(db, int(frm["id"]), frm.get("first_name", ""))
        actor = await load_actor(db, user)
        chat_id = (q.get("message") or {}).get("chat", {}).get("id", frm["id"])
        after.append(("answerCallbackQuery", {"callback_query_id": q["id"]}))
        try:
            replies = await _callback(db, actor, q.get("data", ""))
        except AppError as e:
            await db.rollback()
            replies = [Reply(f"⚠️ {flows.esc(e.message)}")]
        return [(chat_id, r) for r in replies], after
    if kind == "message":
        m = u["message"]
        if (m.get("chat") or {}).get("type") != "private":
            return [], []
        frm = m["from"]
        user = await get_or_create_user_by_tg(db, int(frm["id"]), frm.get("first_name", ""))
        actor = await load_actor(db, user)
        try:
            replies = await _message(db, actor, m)
        except AppError as e:
            await db.rollback()
            replies = [Reply(f"⚠️ {flows.esc(e.message)}")]
        return [(m["chat"]["id"], r) for r in replies], after
    return [], []


async def _callback(db, actor, data: str) -> list[Reply]:
    if data.startswith("m:"):
        return await flows.on_menu_callback(db, actor, data)
    if data.startswith("a:"):
        return await flows.on_admin_callback(db, actor, data)
    if data.startswith("nw:"):
        return await flows.on_wizard_callback(db, actor, data)
    if data.startswith("ns:"):
        return await flows.on_story_callback(db, actor, data)
    if data.startswith("w:"):
        return await flows.on_work_callback(db, actor, data)
    if data.startswith("rv:"):
        return await flows.on_review_callback(db, actor, data)
    if data == "x:resume":
        d = await flows.get_dialog(db, actor.user)
        return [await flows.wizard_prompt(db, actor, d)] if d.flow == "new_work" else [flows.main_menu(actor)]
    if data in ("x:cancel", "x:save"):
        return await flows.on_cancel_or_save(db, actor, data)
    return []


async def _message(db, actor, m: dict) -> list[Reply]:
    text = (m.get("text") or "").strip()
    if text.startswith("/"):
        cmd, _, rest = text.partition(" ")
        cmd = cmd.split("@")[0].lower()
        args = rest.split()
        if cmd == "/start":
            d = await flows.get_dialog(db, actor.user)
            out = await flows.cmd_start(db, actor, args[0] if args else "")
            hint = flows.resume_hint(d)
            return out + ([hint] if hint else [])
        if cmd == "/app":
            return [Reply("Ilovani ochish:", [[flows.webapp("📖 Ochish")]])]
        if cmd == "/help":
            return [flows.help_reply()]
        if cmd == "/settings":
            return [await flows.settings_reply(db, actor)]
        if cmd == "/paysupport":
            return await flows.paysupport_start(db, actor)
        if cmd == "/admin":
            if not (actor.is_staff or actor.own_author_id or actor.has("work.create")):
                return [Reply("Bu bo'lim xodimlar va mualliflar uchun. Muallif bo'lish: /help")]
            return [flows.admin_menu(actor)]
        if cmd == "/new_work":
            return await flows.on_admin_callback(db, actor, "a:new")
        if cmd == "/drafts":
            return await flows.on_admin_callback(db, actor, "a:drafts")
        if cmd == "/new_story":
            return await flows.on_admin_callback(db, actor, "a:story")
        if cmd == "/stats":
            return [await flows.stats_reply(db, actor)]
        if cmd == "/grant":
            return await flows.cmd_grant(db, actor, args)
        if cmd == "/revoke":
            return await flows.cmd_grant(db, actor, args, revoke=True)
        if cmd == "/price":
            return await flows.cmd_price(db, actor, args)
        if cmd == "/cancel":
            return await flows.on_cancel_or_save(db, actor, "x:cancel")
        return [flows.main_menu(actor)]
    d = await flows.get_dialog(db, actor.user)
    if "photo" in m or "document" in m or "video" in m or "audio" in m:
        if d.flow not in ("new_work", "new_story"):
            return [Reply("Fayl qabul qilish uchun avval «Hikoya qo'shish» yoki «Storis»ni boshlang: /admin")]
        if "photo" in m:
            ph = m["photo"][-1]
            data = await _download(ph["file_id"], ph.get("file_size"))
            kind, fname, meta = "photo", "photo.jpg", {"width": ph.get("width"), "height": ph.get("height")}
        elif "video" in m:
            v = m["video"]
            data = await _download(v["file_id"], v.get("file_size"))
            kind, fname, meta = "video", v.get("file_name", "video.mp4"), {"duration": v.get("duration", 0)}
        elif "audio" in m:
            a = m["audio"]
            data = await _download(a["file_id"], a.get("file_size"))
            kind, fname, meta = "document", a.get("file_name", "audio.mp3"), {"duration": a.get("duration", 0)}
        else:
            doc = m["document"]
            data = await _download(doc["file_id"], doc.get("file_size"))
            kind, fname, meta = "document", doc.get("file_name", "file"), {}
        if d.flow == "new_story":
            return await flows.on_story_input(db, actor, d, text=m.get("caption"), media=(kind, data, fname, meta))
        return await flows.on_wizard_file(db, actor, d, kind, data, fname)
    if text:
        return await flows.on_free_text(db, actor, text)
    return []


async def setup_bot() -> None:
    """One-time Telegram configuration. Every step runs and reports its own result."""
    s = get_settings()
    tg = get_telegram()
    steps = [
        ("getMe", {}),
        ("setMyCommands", {"commands": [{"command": c, "description": d} for c, d in [("start", "Boshlash"), ("app", "Ilovani ochish"), ("help", "Yordam"), ("settings", "Sozlamalar"), ("paysupport", "To'lov bo'yicha yordam")]]}),
        ("setChatMenuButton", {"menu_button": {"type": "web_app", "text": "Ilova", "web_app": {"url": s.webapp_url}}}),
    ]
    if s.webhook_secret:
        steps.append(("setWebhook", {"url": f"{s.public_base_url}/api/v1/telegram/webhook", "secret_token": s.webhook_secret, "allowed_updates": ALLOWED_UPDATES, "drop_pending_updates": False}))
    else:
        print("! HIKOYA_WEBHOOK_SECRET bo'sh: webhook o'rnatilmadi (polling rejimi uchun --profile polling)")
    steps.append(("getWebhookInfo", {}))
    for method, params in steps:
        try:
            res = await tg.call(method, **params)
            if method == "getMe":
                print(f"OK getMe: @{res.get('username')} (bot id {res.get('id')})")
                if res.get("username", "").lower() != s.bot_username.lower():
                    print(f"! DIQQAT: .env da HIKOYA_BOT_USERNAME={s.bot_username}, token esa @{res.get('username')} botiga tegishli")
            elif method == "getWebhookInfo":
                print(f"OK webhook: url={res.get('url')} pending={res.get('pending_update_count')} last_error={res.get('last_error_message')}")
            else:
                print(f"OK {method}")
        except Exception as e:  # report and continue with the next step
            print(f"XATO {method}: {type(e).__name__}: {e}")

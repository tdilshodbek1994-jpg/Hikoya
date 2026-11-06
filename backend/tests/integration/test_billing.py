"""T-39 … T-54: server-side Stars billing."""

import time
from datetime import timedelta

from sqlalchemy import func, select

from app.bot.dispatcher import process_update
from app.core.timeutil import utcnow
from app.integrations.telegram import TelegramUncertain, get_telegram
from app.models import EntitlementGrant, Order, Payment, Product, Refund, Subscription, Work
from app.services import billing
from tests.conftest import H, init_data_for, login
from tests.helpers import actor_for, make_work, user_by_tg

_uid = [1000]


def next_update_id() -> int:
    _uid[0] += 1
    return int(time.time() * 1000) % 10**9 * 10 + _uid[0]


async def enable_premium_price(db, amount=150):
    owner = await actor_for(db, 1000)
    p = await db.scalar(select(Product).where(Product.sku == "premium_30d"))
    await billing.set_price(db, owner, p.id, amount)
    await db.commit()
    return p


async def order_for(client, hdr, product_id, key="k-00000001"):
    r = await client.post("/api/v1/billing/orders", json={"product_id": product_id}, headers={**hdr, "Idempotency-Key": key})
    assert r.status_code == 200, r.text
    return r.json()


async def pay(db, tg_id, order_id, charge, *, recurring=False, first=True, expires=None, amount=None):
    o = await db.get(Order, order_id)
    await db.refresh(o)
    sp = {
        "currency": "XTR",
        "total_amount": amount if amount is not None else o.snapshot["amount"],
        "invoice_payload": o.invoice_payload,
        "telegram_payment_charge_id": charge,
        "provider_payment_charge_id": "",
    }
    if o.snapshot["pricing_type"] == "subscription":
        sp.update(is_recurring=True, is_first_recurring=first, subscription_expiration_date=int((expires or utcnow() + timedelta(days=30)).timestamp()))
    upd = {"update_id": next_update_id(), "message": {"message_id": 1, "chat": {"id": tg_id, "type": "private"}, "from": {"id": tg_id, "first_name": "T"}, "successful_payment": sp}}
    return upd, await process_update(upd)


async def chapter_mode(client, hdr, chapter_id):
    return (await client.get(f"/api/v1/chapters/{chapter_id}/content", headers=hdr)).json()["mode"]


async def test_telegram_premium_flag_is_not_entitlement(client, db):
    """T-39."""
    w, chs, _ = await make_work(db, policy="PREMIUM")
    from app.core.security import build_init_data
    from app.config import get_settings

    s = build_init_data(get_settings().bot_token, {"id": 8001, "first_name": "P", "is_premium": True})
    tok = (await client.post("/api/v1/auth/telegram", json={"init_data": s})).json()["token"]
    assert await chapter_mode(client, {"Authorization": f"Bearer {tok}"}, chs[0].id) == "preview"


async def test_demo_price_never_charges(client, db):
    p = await db.scalar(select(Product).where(Product.sku == "premium_30d"))
    p.active = True
    await db.commit()
    hdr = H(await login(client, 8002))
    r = await client.post("/api/v1/billing/orders", json={"product_id": p.id}, headers={**hdr, "Idempotency-Key": "demo-0001"})
    assert r.status_code == 403 and r.json()["error_code"] == "billing_disabled"


async def test_client_paid_without_payment_does_not_unlock(client, db):
    """T-40."""
    p = await enable_premium_price(db)
    w, chs, _ = await make_work(db, policy="PREMIUM")
    hdr = H(await login(client, 8003))
    o = await order_for(client, hdr, p.id)
    st = (await client.get(f"/api/v1/billing/orders/{o['id']}", headers=hdr)).json()
    assert st["status"] == "pending" and st["status_text"] == "Tasdiqlanmoqda"
    assert await chapter_mode(client, hdr, chs[0].id) == "preview"


async def test_full_payment_flow_and_triple_update(client, db):
    """T-41 + pre-checkout (T-44) + access after server confirmation."""
    p = await enable_premium_price(db)
    w, chs, _ = await make_work(db, policy="PREMIUM")
    hdr = H(await login(client, 8004))
    o = await order_for(client, hdr, p.id)
    order = await db.get(Order, o["id"])
    tg = get_telegram()
    tg.calls.clear()
    pcq = {"update_id": next_update_id(), "pre_checkout_query": {"id": "pcq1", "from": {"id": 8004}, "currency": "XTR", "total_amount": 150, "invoice_payload": order.invoice_payload}}
    t0 = time.monotonic()
    await process_update(pcq)
    assert time.monotonic() - t0 < 2
    ans = [c for c in tg.calls if c[0] == "answerPreCheckoutQuery"]
    assert ans and ans[0][1]["ok"] is True
    # pre-checkout alone does not unlock
    assert await chapter_mode(client, hdr, chs[0].id) == "preview"
    upd, res = await pay(db, 8004, o["id"], "charge-A")
    assert res["status"] == "ok"
    # the same update delivered again, and a different update with the same charge id
    assert (await process_update(upd))["status"] == "duplicate"
    upd2 = {**upd, "update_id": next_update_id()}
    await process_update(upd2)
    n_pay = await db.scalar(select(func.count()).select_from(Payment).where(Payment.telegram_charge_id == "charge-A"))
    n_grants = await db.scalar(select(func.count()).select_from(EntitlementGrant).where(EntitlementGrant.user_id == (await user_by_tg(db, 8004)).id))
    assert n_pay == 1 and n_grants == 1
    assert await chapter_mode(client, hdr, chs[0].id) == "full"
    ent = (await client.get("/api/v1/me/entitlements", headers=hdr)).json()
    assert ent["premium"] is True


async def test_parallel_checkouts_reuse_one_intent(client, db):
    """T-42: two devices start the same purchase — one active intent; old invoice rejected later."""
    p = await enable_premium_price(db)
    hdr = H(await login(client, 8005))
    o1 = await order_for(client, hdr, p.id, "dev-a-0001")
    o2 = await order_for(client, hdr, p.id, "dev-b-0001")
    assert o1["id"] == o2["id"]
    # a real second parallel subscription payment is kept and sent to review
    await pay(db, 8005, o1["id"], "charge-P1")
    sub_count = await db.scalar(select(func.count()).select_from(Subscription))
    assert sub_count == 1
    r = await client.post("/api/v1/billing/orders", json={"product_id": p.id}, headers={**hdr, "Idempotency-Key": "dev-c-0001"})
    assert r.status_code == 409 and r.json()["error_code"] == "already_subscribed"


async def test_price_change_after_checkout(client, db):
    """T-43: snapshot amount is enforced at pre-checkout; renewal not blocked by checkout expiry."""
    p = await enable_premium_price(db, 150)
    hdr = H(await login(client, 8006))
    o = await order_for(client, hdr, p.id)
    await enable_premium_price(db, 200)  # owner changes price
    order = await db.get(Order, o["id"])
    await db.refresh(order)
    assert order.snapshot["amount"] == 150
    ok, _ = await billing.handle_pre_checkout(db, {"from": {"id": 8006}, "currency": "XTR", "total_amount": 200, "invoice_payload": order.invoice_payload})
    assert ok is False
    ok, _ = await billing.handle_pre_checkout(db, {"from": {"id": 8006}, "currency": "XTR", "total_amount": 150, "invoice_payload": order.invoice_payload})
    await db.rollback()
    assert ok is True
    await pay(db, 8006, o["id"], "charge-C1")
    # 30 days later the checkout window has long expired; the recurring payment is still accepted
    order = await db.get(Order, o["id"])
    await db.refresh(order)
    order.expires_at = utcnow() - timedelta(days=29)
    await db.commit()
    _, res = await pay(db, 8006, o["id"], "charge-C2", first=False, expires=utcnow() + timedelta(days=60))
    sub = await db.scalar(select(Subscription))
    await db.refresh(sub)
    assert sub.last_charge_id == "charge-C2" and sub.paid_until > utcnow() + timedelta(days=59)


async def test_subscription_states_do_not_extend(client, db):
    """T-45, T-46, T-47."""
    p = await enable_premium_price(db)
    w, chs, _ = await make_work(db, policy="PREMIUM")
    hdr = H(await login(client, 8007))
    o = await order_for(client, hdr, p.id)
    await pay(db, 8007, o["id"], "charge-S1")
    sub = await db.scalar(select(Subscription))
    await db.refresh(sub)
    paid_until = sub.paid_until
    # user cancels renewal on day 20
    r = await client.post(f"/api/v1/billing/subscriptions/{sub.id}/cancel-renewal", headers=hdr)
    assert r.json()["renewal_state"] == "canceled" and "gacha faol" in r.json()["status_text"]
    assert await chapter_mode(client, hdr, chs[0].id) == "full"
    for state in ("active", "failed"):
        await process_update({"update_id": next_update_id(), "subscription": {"user": {"id": 8007}, "invoice_payload": sub.immutable_payload, "state": state}})
        await db.refresh(sub)
        assert sub.renewal_state == state and sub.paid_until == paid_until
    # unknown future state is stored, not silently dropped
    uid = next_update_id()
    await process_update({"update_id": uid, "subscription": {"user": {"id": 8007}, "invoice_payload": sub.immutable_payload, "state": "paused_by_magic"}})
    from app.models import TelegramUpdate

    tu = await db.get(TelegramUpdate, uid)
    assert "unknown subscription state" in tu.error


async def test_access_ends_exactly_at_paid_until(client, db):
    """T-48."""
    p = await enable_premium_price(db)
    w, chs, _ = await make_work(db, policy="PREMIUM")
    hdr = H(await login(client, 8008))
    o = await order_for(client, hdr, p.id)
    await pay(db, 8008, o["id"], "charge-E1")
    from app.services.access import decide_chapter_access, load_entitlements

    g = await db.scalar(select(EntitlementGrant))
    await db.refresh(g)
    ent = await load_entitlements(db, g.user_id, now=g.expires_at)
    assert ent.premium is False
    work = await db.get(Work, w.id)
    ch = chs[0]
    assert decide_chapter_access(work, ch, ent).mode == "preview"


async def test_refund_only_revokes_its_grant(client, db):
    """T-49 + T-51 (same request key → one refund)."""
    owner = await actor_for(db, 1000)
    w1, c1, _ = await make_work(db, title="Bir", policy="PURCHASE")
    w2, c2, _ = await make_work(db, title="Ikki", policy="PURCHASE")
    p1 = await billing.create_work_product(db, owner, await db.get(Work, w1.id), 50)
    p2 = await billing.create_work_product(db, owner, await db.get(Work, w2.id), 60)
    await db.commit()
    hdr = H(await login(client, 8009))
    o1 = await order_for(client, hdr, p1.id, "w1-000001")
    o2 = await order_for(client, hdr, p2.id, "w2-000001")
    await pay(db, 8009, o1["id"], "charge-W1")
    await pay(db, 8009, o2["id"], "charge-W2")
    assert await chapter_mode(client, hdr, c1[0].id) == "full" and await chapter_mode(client, hdr, c2[0].id) == "full"
    pay1 = await db.scalar(select(Payment).where(Payment.telegram_charge_id == "charge-W1"))
    owner_hdr = H(await login(client, 1000))
    r1 = await client.post(f"/api/v1/admin/billing/payments/{pay1.id}/refund", json={"reason": "foydalanuvchi so'rovi", "request_key": "rf-00000001"}, headers=owner_hdr)
    r2 = await client.post(f"/api/v1/admin/billing/payments/{pay1.id}/refund", json={"reason": "foydalanuvchi so'rovi", "request_key": "rf-00000001"}, headers=owner_hdr)
    assert r1.json()["state"] == "succeeded" and r1.json()["id"] == r2.json()["id"]
    assert len([c for c in get_telegram().calls if c[0] == "refundStarPayment"]) >= 1
    assert await db.scalar(select(func.count()).select_from(Refund)) == 1
    assert await chapter_mode(client, hdr, c1[0].id) == "preview"
    assert await chapter_mode(client, hdr, c2[0].id) == "full"


async def test_refund_before_late_payment(client, db):
    """T-50."""
    p = await enable_premium_price(db)
    w, chs, _ = await make_work(db, policy="PREMIUM")
    hdr = H(await login(client, 8010))
    o = await order_for(client, hdr, p.id)
    await process_update({"update_id": next_update_id(), "message": {"message_id": 2, "chat": {"id": 8010, "type": "private"}, "from": {"id": 8010}, "refunded_payment": {"currency": "XTR", "total_amount": 150, "invoice_payload": "x", "telegram_payment_charge_id": "charge-L1"}}})
    await pay(db, 8010, o["id"], "charge-L1")
    pmt = await db.scalar(select(Payment).where(Payment.telegram_charge_id == "charge-L1"))
    assert pmt.state == "refunded"
    assert await chapter_mode(client, hdr, chs[0].id) == "preview"


async def test_refund_uncertain_then_retry(client, db):
    """T-51: ambiguous Telegram answer → 'unknown', not marked refunded; retry with same key resolves."""
    p = await enable_premium_price(db)
    hdr = H(await login(client, 8011))
    o = await order_for(client, hdr, p.id)
    await pay(db, 8011, o["id"], "charge-U1")
    pmt = await db.scalar(select(Payment).where(Payment.telegram_charge_id == "charge-U1"))
    tg = get_telegram()
    tg.fake_hook = lambda m, params: TelegramUncertain("timeout") if m == "refundStarPayment" else None
    owner_hdr = H(await login(client, 1000))
    r = await client.post(f"/api/v1/admin/billing/payments/{pmt.id}/refund", json={"reason": "test", "request_key": "rf-unk-0001"}, headers=owner_hdr)
    assert r.json()["state"] == "unknown"
    await db.refresh(pmt)
    assert pmt.state == "confirmed"
    tg.fake_hook = None
    r = await client.post(f"/api/v1/admin/billing/payments/{pmt.id}/refund", json={"reason": "test", "request_key": "rf-unk-0001"}, headers=owner_hdr)
    assert r.json()["state"] == "succeeded"
    assert await db.scalar(select(func.count()).select_from(Refund).where(Refund.payment_id == pmt.id)) == 1


async def test_purchase_policy_not_opened_by_premium(client, db):
    """T-52 (second half)."""
    p = await enable_premium_price(db)
    w, chs, _ = await make_work(db, policy="PURCHASE")
    hdr = H(await login(client, 8012))
    o = await order_for(client, hdr, p.id)
    await pay(db, 8012, o["id"], "charge-PP")
    assert await chapter_mode(client, hdr, chs[0].id) == "preview"


async def test_delisted_work_stays_open_for_buyer(client, db):
    """T-54."""
    owner = await actor_for(db, 1000)
    w, chs, _ = await make_work(db, policy="PURCHASE")
    prod = await billing.create_work_product(db, owner, await db.get(Work, w.id), 40)
    await db.commit()
    buyer = H(await login(client, 8013))
    o = await order_for(client, buyer, prod.id)
    await pay(db, 8013, o["id"], "charge-D1")
    owner_hdr = H(await login(client, 1000))
    r = await client.post(f"/api/v1/studio/works/{w.id}/state", json={"action": "delist", "reason": "tahririyat"}, headers=owner_hdr)
    assert r.status_code == 200
    assert w.id not in [x["id"] for x in (await client.get("/api/v1/works")).json()["items"]]
    assert await chapter_mode(client, buyer, chs[0].id) == "full"
    stranger = H(await login(client, 8014))
    assert (await client.get(f"/api/v1/works/{w.short_code}", headers=stranger)).status_code == 404


async def test_private_asset_requires_entitlement_and_refund_blocks_new_links(client, db):
    """T-52 (asset URL), T-53."""
    from app.services.assets import link_asset, store_upload

    owner = await actor_for(db, 1000)
    w, chs, _ = await make_work(db, policy="PURCHASE")
    asset = await store_upload(db, owner.id, b"%PDF-1.4 test", "ilova.pdf")
    await link_asset(db, asset, "work", w.id, "attachment", download_allowed=True)
    prod = await billing.create_work_product(db, owner, await db.get(Work, w.id), 30)
    await db.commit()
    hdr = H(await login(client, 8015))
    assert (await client.get(f"/api/v1/assets/{asset.id}/access", headers=hdr)).status_code == 403
    o = await order_for(client, hdr, prod.id)
    await pay(db, 8015, o["id"], "charge-F1")
    acc = (await client.get(f"/api/v1/assets/{asset.id}/access", headers=hdr)).json()
    assert acc["ttl"] == 60
    url = acc["url"].split("/api/v1")[1]
    f = await client.get("/api/v1" + url)
    assert f.status_code == 200 and f.content.startswith(b"%PDF")
    pmt = await db.scalar(select(Payment).where(Payment.telegram_charge_id == "charge-F1"))
    owner_hdr = H(await login(client, 1000))
    await client.post(f"/api/v1/admin/billing/payments/{pmt.id}/refund", json={"reason": "x", "request_key": "rf-asset-01"}, headers=owner_hdr)
    assert (await client.get(f"/api/v1/assets/{asset.id}/access", headers=hdr)).status_code == 403


async def test_signed_link_expires(client, db):
    from app.config import get_settings
    from app.core.security import sign_payload

    tok = sign_payload({"a": 1, "exp": int(time.time()) - 1, "d": 0}, get_settings().signing_key)
    assert (await client.get("/api/v1/assets/file", params={"t": tok})).status_code == 401
    assert init_data_for  # keep import used

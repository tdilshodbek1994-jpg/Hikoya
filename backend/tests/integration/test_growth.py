"""Promo codes and invite-a-friend rewards."""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select

from app.config import get_settings
from app.models import Notification, QualifiedRead, Referral
from app.services.growth import reward_referrals
from app.services.notify import process_outbox
from tests.conftest import H, init_data_for, login
from tests.helpers import make_work, user_by_tg


async def _premium(client, hdr) -> bool:
    return (await client.get("/api/v1/me/entitlements", headers=hdr)).json()["premium"]


async def test_promo_code_lifecycle(client, db):
    ohdr = H(await login(client, 1000))
    r = await client.post("/api/v1/admin/promo-codes", json={"code": "kuz-2026", "days": 7, "max_uses": 2, "note": "Kuzgi aksiya"}, headers=ohdr)
    assert r.status_code == 200, r.text
    promo = r.json()
    assert promo["code"] == "KUZ-2026"
    assert (await client.post("/api/v1/admin/promo-codes", json={"code": "KUZ-2026", "days": 7}, headers=ohdr)).status_code == 409
    reader = H(await login(client, 8600))
    assert (await client.post("/api/v1/admin/promo-codes", json={"days": 7}, headers=reader)).status_code == 403
    assert not await _premium(client, reader)
    r = await client.post("/api/v1/promo/redeem", json={"code": " kuz-2026 "}, headers=reader)
    assert r.status_code == 200 and r.json()["days"] == 7
    assert await _premium(client, reader)
    again = await client.post("/api/v1/promo/redeem", json={"code": "KUZ-2026"}, headers=reader)
    assert again.status_code == 409 and again.json()["error_code"] == "promo_already_used"
    second = H(await login(client, 8601))
    assert (await client.post("/api/v1/promo/redeem", json={"code": "KUZ-2026"}, headers=second)).status_code == 200
    third = H(await login(client, 8602))
    r = await client.post("/api/v1/promo/redeem", json={"code": "KUZ-2026"}, headers=third)
    assert r.status_code == 409 and r.json()["error_code"] == "promo_exhausted"
    assert (await client.post("/api/v1/promo/redeem", json={"code": "YOQKOD"}, headers=third)).json()["error_code"] == "promo_not_found"
    # deactivated codes look like unknown ones
    r = await client.post("/api/v1/admin/promo-codes", json={"code": "QISH", "days": 3}, headers=ohdr)
    await client.delete(f"/api/v1/admin/promo-codes/{r.json()['id']}", headers=ohdr)
    assert (await client.post("/api/v1/promo/redeem", json={"code": "QISH"}, headers=third)).json()["error_code"] == "promo_not_found"
    items = (await client.get("/api/v1/admin/promo-codes", headers=ohdr)).json()["items"]
    assert {i["code"]: i["uses"] for i in items}["KUZ-2026"] == 2


async def test_promo_days_stack_after_existing_premium(client, db):
    ohdr = H(await login(client, 1000))
    await client.post("/api/v1/admin/promo-codes", json={"code": "BIRINCHI", "days": 5}, headers=ohdr)
    await client.post("/api/v1/admin/promo-codes", json={"code": "IKKINCHI", "days": 5}, headers=ohdr)
    hdr = H(await login(client, 8603))
    a = (await client.post("/api/v1/promo/redeem", json={"code": "BIRINCHI"}, headers=hdr)).json()
    b = (await client.post("/api/v1/promo/redeem", json={"code": "IKKINCHI"}, headers=hdr)).json()
    from datetime import datetime

    gap = datetime.fromisoformat(b["premium_until"]) - datetime.fromisoformat(a["premium_until"])
    assert abs(gap - timedelta(days=5)) < timedelta(seconds=5)


async def test_referral_rewarded_only_after_real_read(client, db):
    inviter = H(await login(client, 8610))
    me = (await client.get("/api/v1/me/referrals", headers=inviter)).json()
    inviter_user = await user_by_tg(db, 8610)
    assert me["link"].endswith(f"startapp=r_{inviter_user.id}") and me["invited"] == 0
    # a brand-new friend opens the app through the link
    r = await client.post("/api/v1/auth/telegram", json={"init_data": init_data_for(8611, "Do'st", start_param=f"r_{inviter_user.id}")})
    assert r.status_code == 200
    friend = await user_by_tg(db, 8611)
    assert (await db.get(Referral, friend.id)).referrer_user_id == inviter_user.id
    # an existing (old) user cannot be claimed, and nobody can refer themselves
    old = await user_by_tg(db, 8610)
    await client.post("/api/v1/auth/telegram", json={"init_data": init_data_for(8610, "X", start_param=f"r_{inviter_user.id}")})
    assert await db.get(Referral, old.id) is None
    await reward_referrals(db)
    await db.commit()
    assert not await _premium(client, inviter)  # opening the app is not enough
    w, chs, _ = await make_work(db)
    db.add(QualifiedRead(user_id=friend.id, work_id=w.id, local_date=date.today()))
    await db.commit()
    assert await reward_referrals(db) == 1
    await db.commit()
    assert await reward_referrals(db) == 0  # paid once
    await db.commit()
    assert await _premium(client, inviter)
    me = (await client.get("/api/v1/me/referrals", headers=inviter)).json()
    assert me["invited"] == 1 and me["rewarded"] == 1 and me["days_earned"] == get_settings().referral_bonus_days
    await process_outbox(db)
    await db.commit()
    assert await db.scalar(select(Notification).where(Notification.user_id == inviter_user.id, Notification.title.like("%Do'stingiz%")))


async def test_referral_monthly_cap(client, db):
    s = get_settings()
    old = s.referral_max_rewards_per_month
    s.referral_max_rewards_per_month = 1
    try:
        await login(client, 8620)
        inviter = await user_by_tg(db, 8620)
        w, chs, _ = await make_work(db)
        for tg in (8621, 8622):
            await client.post("/api/v1/auth/telegram", json={"init_data": init_data_for(tg, "D", start_param=f"r_{inviter.id}")})
            u = await user_by_tg(db, tg)
            db.add(QualifiedRead(user_id=u.id, work_id=w.id, local_date=date.today()))
        await db.commit()
        assert await reward_referrals(db) == 1
        await db.commit()
        skipped = (await db.scalars(select(Referral).where(Referral.reward_skipped == "monthly_limit"))).all()
        assert len(skipped) == 1
    finally:
        s.referral_max_rewards_per_month = old

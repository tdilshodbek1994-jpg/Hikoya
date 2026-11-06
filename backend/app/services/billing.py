"""Telegram Stars billing: orders, invoices, payments, subscriptions, refunds, entitlements (spec 19–20).

Rules that must hold (acceptance tests T-40 … T-53):
* only a server-confirmed successful_payment grants access; pre-checkout or a client "paid" never does;
* update_id and telegram_payment_charge_id are processed once; one payment → one grant per scope;
* order snapshot terms are immutable; price changes never alter an existing order;
* subscription state updates never extend paid_until by themselves;
* refunds revoke only the grant created by the refunded payment, and a late payment never revives it.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.timeutil import utcnow
from app.integrations.telegram import TelegramError, TelegramUncertain, get_telegram
from app.models import (
    EntitlementGrant,
    Order,
    Payment,
    Product,
    ProductVersion,
    PurchaseIntentLock,
    Refund,
    RefundedCharge,
    Subscription,
    SupportTicket,
    TelegramUpdate,
    User,
    Work,
)
from app.services.access import active_grant_filter
from app.services.events import emit
from app.services.identity import Actor, audit

SUBSCRIPTION_PERIOD = 2592000  # Telegram Stars subscriptions are 30 days


def _scope_key(product: Product) -> str:
    return "premium" if product.access_scope == "premium" else f"work:{product.scope_id}"


async def current_version(db: AsyncSession, product: Product) -> ProductVersion | None:
    return await db.scalar(select(ProductVersion).where(ProductVersion.product_id == product.id, ProductVersion.active.is_(True)).order_by(ProductVersion.version.desc()).limit(1))


async def list_products(db: AsyncSession, work_id: int | None = None) -> list[dict]:
    q = select(Product).where(Product.active.is_(True))
    q = q.where(Product.access_scope == "work", Product.scope_id == work_id) if work_id else q.where(Product.access_scope == "premium")
    out = []
    for p in (await db.scalars(q.order_by(Product.sort_order, Product.id))).all():
        v = await current_version(db, p)
        if v is None:
            continue
        out.append(
            {
                "id": p.id,
                "sku": p.sku,
                "title": p.title,
                "description": p.description,
                "pricing_type": p.pricing_type,
                "access_scope": p.access_scope,
                "scope_id": p.scope_id,
                "amount": v.amount,
                "currency": v.currency,
                "duration_days": v.duration_days,
                "version": v.version,
                "is_demo": v.is_demo,
                "purchasable": get_settings().billing_enabled and not v.is_demo,
                "covers": ("Premium katalogdagi barcha asarlar" if p.access_scope == "premium" else "Shu asarning mavjud va kelajakdagi boblari. Boshqa asarlar kirmaydi."),
            }
        )
    return out


async def set_price(db: AsyncSession, actor: Actor, product_id: int, amount: int, duration_days: int | None = None, activate: bool = True) -> ProductVersion:
    """Owner sets a real price: creates a new immutable version (old orders keep their snapshot)."""
    actor.require("billing.manage_products")
    product = await db.get(Product, product_id)
    if product is None:
        raise NotFound()
    if amount < 1 or amount > 10000 or int(amount) != amount:
        raise Invalid("Narx butun Stars sonida, 1–10000", code="price_invalid")
    cur = await current_version(db, product)
    last = await db.scalar(select(ProductVersion.version).where(ProductVersion.product_id == product.id).order_by(ProductVersion.version.desc()).limit(1)) or 0
    await db.execute(update(ProductVersion).where(ProductVersion.product_id == product.id).values(active=False))
    if product.pricing_type == "subscription":
        duration_days = 30
    v = ProductVersion(product_id=product.id, version=last + 1, amount=int(amount), duration_days=duration_days or (cur.duration_days if cur else None), active=True, is_demo=False, created_by=actor.id)
    db.add(v)
    product.active = activate
    await db.flush()
    await audit(db, actor, "billing.set_price", "product", product.id, before={"amount": cur.amount if cur else None}, after={"amount": amount, "version": v.version})
    return v


async def create_work_product(db: AsyncSession, actor: Actor, work: Work, amount: int) -> Product:
    actor.require("billing.manage_products")
    sku = f"work_{work.id}"
    p = await db.scalar(select(Product).where(Product.sku == sku))
    if p is None:
        p = Product(sku=sku, title=f"«{work.title}» asarini sotib olish", description="Shu asarning mavjud va kelajakdagi boblari.", access_scope="work", scope_id=work.id, pricing_type="one_time", active=False)
        db.add(p)
        await db.flush()
    await set_price(db, actor, p.id, amount)
    return p


async def _lock_intent(db: AsyncSession, user_id: int, scope_key: str) -> PurchaseIntentLock:
    # never wait longer than the pre-checkout window
    await db.execute(text("SET LOCAL lock_timeout = '3s'"))
    await db.execute(insert(PurchaseIntentLock).values(user_id=user_id, scope_key=scope_key).on_conflict_do_nothing())
    lock = await db.scalar(select(PurchaseIntentLock).where(PurchaseIntentLock.user_id == user_id, PurchaseIntentLock.scope_key == scope_key).with_for_update())
    assert lock is not None
    return lock


async def active_subscription(db: AsyncSession, user_id: int, product_id: int, now: datetime | None = None) -> Subscription | None:
    now = now or utcnow()
    return await db.scalar(
        select(Subscription).where(Subscription.user_id == user_id, Subscription.product_id == product_id, Subscription.paid_until > now).order_by(Subscription.paid_until.desc()).limit(1)
    )


async def create_order(db: AsyncSession, user: User, product_id: int, idempotency_key: str) -> Order:
    s = get_settings()
    if not idempotency_key or len(idempotency_key) > 80:
        raise Invalid("Idempotency-Key kerak", code="idempotency_required")
    existing = await db.scalar(select(Order).where(Order.user_id == user.id, Order.idempotency_key == idempotency_key))
    if existing:
        return existing
    product = await db.get(Product, product_id)
    if product is None or not product.active:
        raise NotFound("Mahsulot topilmadi")
    version = await current_version(db, product)
    if version is None:
        raise NotFound("Mahsulot narxi belgilanmagan")
    if not s.billing_enabled or version.is_demo:
        # demo prices never turn into a real payment
        raise Forbidden("To'lovlar hozircha yoqilmagan", code="billing_disabled")
    scope_key = _scope_key(product)
    lock = await _lock_intent(db, user.id, scope_key)
    now = utcnow()
    if product.pricing_type == "subscription":
        sub = await active_subscription(db, user.id, product.id, now)
        if sub and sub.renewal_state == "active":
            raise Conflict("Sizda faol obuna bor", code="already_subscribed", paid_until=sub.paid_until.isoformat() if sub.paid_until else None)
    if product.access_scope == "work":
        has = await db.scalar(select(EntitlementGrant.id).where(EntitlementGrant.user_id == user.id, EntitlementGrant.scope_type == "work", EntitlementGrant.scope_id == product.scope_id, active_grant_filter(now)))
        if has:
            raise Conflict("Bu asar allaqachon sotib olingan", code="already_purchased")
    # reuse the single active checkout for this scope (T-42) if terms are still current
    if lock.active_order_id:
        prev = await db.get(Order, lock.active_order_id)
        if prev and prev.status in ("created", "pending") and prev.expires_at > now and prev.product_version_id == version.id:
            return prev
        if prev and prev.status in ("created", "pending"):
            prev.status = "superseded" if prev.expires_at > now else "expired"
    snapshot = {
        "product_id": product.id,
        "sku": product.sku,
        "product_version_id": version.id,
        "product_version": version.version,
        "title": product.title,
        "currency": version.currency,
        "amount": version.amount,
        "access_scope": product.access_scope,
        "scope_id": product.scope_id,
        "pricing_type": product.pricing_type,
        "duration_days": version.duration_days,
        "user_id": user.id,
        "created_at": now.isoformat(),
    }
    payload = f"o{secrets.token_urlsafe(18)}"  # unique per order; never a shared "premium" payload
    order = Order(
        user_id=user.id,
        product_version_id=version.id,
        snapshot=snapshot,
        invoice_payload=payload,
        status="created",
        idempotency_key=idempotency_key,
        scope_key=scope_key,
        expires_at=now + timedelta(minutes=s.order_ttl_minutes),
    )
    db.add(order)
    await db.flush()
    link = await get_telegram().call(
        "createInvoiceLink",
        title=product.title[:32],
        description=(product.description or product.title)[:255],
        payload=payload,
        currency="XTR",
        prices=[{"label": product.title[:32], "amount": version.amount}],
        subscription_period=SUBSCRIPTION_PERIOD if product.pricing_type == "subscription" else None,
    )
    order.invoice_link = str(link)
    order.status = "pending"
    lock.active_order_id = order.id
    lock.updated_at = now
    return order


def order_dto(o: Order, payment: Payment | None = None) -> dict:
    status_text = {
        "created": "To'lov kutilmoqda",
        "pending": "To'lov kutilmoqda",
        "paid": "To'lov tasdiqlandi",
        "expired": "Muddati o'tgan, qaytadan boshlang",
        "superseded": "Yangi to'lov oynasi ochilgan",
        "failed": "To'lov amalga oshmadi",
        "canceled": "Bekor qilingan",
    }.get(o.status, o.status)
    if payment and payment.state == "refunded":
        status_text = "To'lov qaytarildi"
    return {
        "id": o.id,
        "status": o.status,
        "status_text": status_text,
        "invoice_link": o.invoice_link if o.status == "pending" else None,
        "terms": {k: o.snapshot.get(k) for k in ("title", "amount", "currency", "pricing_type", "duration_days", "access_scope", "scope_id")},
        "expires_at": o.expires_at.isoformat(),
        "paid_at": o.paid_at.isoformat() if o.paid_at else None,
    }


async def get_order_for_user(db: AsyncSession, user: User, order_id: int) -> dict:
    """The client polls this after invoiceClosed. "paid" on the client alone is never trusted (T-40)."""
    o = await db.get(Order, order_id)
    if o is None or o.user_id != user.id:
        raise NotFound()
    p = await db.scalar(select(Payment).where(Payment.order_id == o.id).order_by(Payment.id.desc()).limit(1))
    dto = order_dto(o, p)
    if o.status == "pending":
        dto["status_text"] = "Tasdiqlanmoqda"
    return dto


async def claim_update(db: AsyncSession, update_id: int, kind: str, payload: dict | None = None) -> bool:
    """True if this update_id is new. A repeated webhook delivery returns False."""
    res = await db.execute(
        insert(TelegramUpdate).values(update_id=update_id, kind=kind, payload=payload).on_conflict_do_nothing(index_elements=["update_id"]).returning(TelegramUpdate.update_id)
    )
    return res.scalar() is not None


async def handle_pre_checkout(db: AsyncSession, q: dict) -> tuple[bool, str]:
    """Light-weight check answered well within Telegram's 10 s window (T-44). Grants nothing."""
    payload = str(q.get("invoice_payload", ""))
    order = await db.scalar(select(Order).where(Order.invoice_payload == payload))
    if order is None:
        return False, "Buyurtma topilmadi. Ilovadan qaytadan urinib ko'ring."
    user = await db.get(User, order.user_id)
    if user is None or user.telegram_user_id != int((q.get("from") or {}).get("id", 0)):
        return False, "Buyurtma boshqa foydalanuvchiga tegishli."
    if q.get("currency") != order.snapshot.get("currency") or int(q.get("total_amount", -1)) != int(order.snapshot.get("amount", -2)):
        return False, "Narx o'zgargan. Ilovadan yangi to'lov oynasini oching."  # T-43
    now = utcnow()
    if order.status not in ("pending", "created") or order.expires_at <= now:
        return False, "To'lov oynasi eskirgan. Ilovadan yangisini oching."
    try:
        lock = await _lock_intent(db, user.id, order.scope_key)
    except Exception:
        return False, "Server band, birozdan keyin urinib ko'ring."
    if lock.active_order_id not in (None, order.id):
        return False, "Bu xarid uchun yangiroq to'lov oynasi ochilgan."
    if order.snapshot.get("pricing_type") == "subscription":
        sub = await active_subscription(db, user.id, order.snapshot["product_id"], now)
        if sub and sub.renewal_state == "active" and sub.original_order_id != order.id:
            return False, "Sizda faol obuna bor."
    return True, ""


def _ts(v) -> datetime | None:
    if not v:
        return None
    return datetime.fromtimestamp(int(v), tz=timezone.utc)


async def _grant(db: AsyncSession, user_id: int, source: str, source_id: str, scope_type: str, scope_id: int, starts: datetime, expires: datetime | None, terms: dict) -> None:
    await db.execute(
        insert(EntitlementGrant)
        .values(user_id=user_id, source_type=source, source_id=source_id, scope_type=scope_type, scope_id=scope_id, starts_at=starts, expires_at=expires, terms=terms)
        .on_conflict_do_nothing(index_elements=["source_type", "source_id", "scope_type", "scope_id"])
    )


async def handle_successful_payment(db: AsyncSession, telegram_user_id: int, sp: dict) -> Payment | None:
    """Record a confirmed payment and grant access in ONE transaction (payment + grant + outbox)."""
    charge = str(sp.get("telegram_payment_charge_id", ""))
    if not charge:
        return None
    existing = await db.scalar(select(Payment).where(Payment.telegram_charge_id == charge))
    if existing:
        return existing  # T-41: duplicates do not add another 30 days
    payload = str(sp.get("invoice_payload", ""))
    order = await db.scalar(select(Order).where(Order.invoice_payload == payload).with_for_update())
    user = await db.scalar(select(User).where(User.telegram_user_id == telegram_user_id))
    now = utcnow()
    pay = Payment(
        order_id=order.id if order else None,
        user_id=(order.user_id if order else (user.id if user else 0)),
        telegram_charge_id=charge,
        provider_charge_id=str(sp.get("provider_payment_charge_id", "") or ""),
        invoice_payload=payload,
        amount=int(sp.get("total_amount", 0)),
        currency=str(sp.get("currency", "")),
        is_recurring=bool(sp.get("is_recurring")),
        is_first_recurring=bool(sp.get("is_first_recurring")),
        subscription_expiration_date=_ts(sp.get("subscription_expiration_date")),
    )
    if order is None or user is None or order.user_id != user.id:
        pay.state, pay.review_reason = "needs_review", "Buyurtma yoki foydalanuvchi mos emas"
        if pay.user_id == 0:
            return None
        db.add(pay)
        await db.flush()
        return pay
    snap = order.snapshot
    if pay.currency != snap.get("currency") or pay.amount != int(snap.get("amount", -1)):
        pay.state, pay.review_reason = "needs_review", "Summa buyurtma shartlariga mos emas"
        db.add(pay)
        await db.flush()
        await _open_review_ticket(db, pay, "Summa mos emas")
        return pay
    refunded_before = await db.get(RefundedCharge, charge)
    db.add(pay)
    await db.flush()
    if refunded_before:
        # T-50: refund arrived first; the late payment never re-activates access
        pay.state = "refunded"
        order.status = "paid"
        order.paid_at = order.paid_at or now
        return pay
    terms = {k: snap.get(k) for k in ("sku", "product_version", "amount", "currency", "duration_days", "access_scope", "scope_id")}
    if snap.get("pricing_type") == "subscription":
        expires = pay.subscription_expiration_date or (now + timedelta(days=30))
        sub = await db.scalar(select(Subscription).where(Subscription.immutable_payload == payload).with_for_update())
        if sub is None:
            other = await active_subscription(db, user.id, snap["product_id"], now)
            sub = Subscription(user_id=user.id, product_id=snap["product_id"], original_order_id=order.id, immutable_payload=payload, renewal_state="active", paid_until=expires, first_charge_id=charge, last_charge_id=charge)
            db.add(sub)
            await db.flush()
            if other is not None:
                # a second real parallel subscription: keep it, give access, open a review/refund case (T-42)
                pay.state, pay.review_reason = "needs_review", f"Parallel obuna: #{other.id} hali faol"
                await _open_review_ticket(db, pay, "Ikkinchi parallel obuna to'lovi")
        else:
            # a genuine renewal is never rejected as a new parallel purchase, even after checkout expiry (T-43)
            if sub.paid_until is None or expires > sub.paid_until:
                sub.paid_until = expires
            sub.last_charge_id = charge
            sub.renewal_state = "active"
        pay.subscription_id = sub.id
        await _grant(db, user.id, "payment", str(pay.id), "premium", 0, now, expires, terms)
    else:
        if snap.get("access_scope") == "work":
            await _grant(db, user.id, "payment", str(pay.id), "work", int(snap["scope_id"]), now, None, terms)
        else:
            # one-time premium package stacks after the current paid period
            from app.services.access import load_entitlements

            ent = await load_entitlements(db, user.id, now)
            start = max(now, ent.premium_until) if ent.premium_until else now
            await _grant(db, user.id, "payment", str(pay.id), "premium", 0, start, start + timedelta(days=int(snap.get("duration_days") or 30)), terms)
    order.status = "paid"
    order.paid_at = order.paid_at or now
    await db.execute(update(PurchaseIntentLock).where(PurchaseIntentLock.user_id == user.id, PurchaseIntentLock.scope_key == order.scope_key, PurchaseIntentLock.active_order_id == order.id).values(active_order_id=None))
    await emit(db, f"billing.paid:{pay.id}", "billing.paid", {"payment_id": pay.id, "user_id": user.id, "renewal": pay.is_recurring and not pay.is_first_recurring})
    return pay


async def _open_review_ticket(db: AsyncSession, pay: Payment, subject: str) -> None:
    db.add(SupportTicket(user_id=pay.user_id, category="payment", order_id=pay.order_id, payment_id=pay.id, subject=subject, status="open"))


async def handle_subscription_update(db: AsyncSession, upd: dict, update_id: int) -> Subscription | None:
    """canceled/active/failed change renewal_state only; paid_until is never extended here (T-45..T-47)."""
    payload = str(upd.get("invoice_payload", ""))
    state = str(upd.get("state", ""))
    sub = await db.scalar(select(Subscription).where(Subscription.immutable_payload == payload).with_for_update())
    if sub is None:
        return None
    if state in ("canceled", "active", "failed"):
        sub.renewal_state = state
    else:
        # unknown future state: stored on the update record, never silently dropped
        await db.execute(update(TelegramUpdate).where(TelegramUpdate.update_id == update_id).values(error=f"unknown subscription state {state}"))
    sub.last_provider_update_id = update_id
    await emit(db, f"billing.sub:{sub.id}:{update_id}", "billing.subscription", {"subscription_id": sub.id, "user_id": sub.user_id, "state": state})
    return sub


async def _revoke_payment_grants(db: AsyncSession, pay: Payment, reason: str) -> int:
    res = await db.execute(
        update(EntitlementGrant)
        .where(EntitlementGrant.source_type == "payment", EntitlementGrant.source_id == str(pay.id), EntitlementGrant.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoke_reason=reason)
        .returning(EntitlementGrant.id)
    )
    return len(res.all())


async def handle_refunded_payment(db: AsyncSession, rp: dict) -> Payment | None:
    charge = str(rp.get("telegram_payment_charge_id", ""))
    if not charge:
        return None
    await db.execute(insert(RefundedCharge).values(telegram_charge_id=charge).on_conflict_do_nothing())
    pay = await db.scalar(select(Payment).where(Payment.telegram_charge_id == charge).with_for_update())
    if pay is None:
        return None  # tombstone stays; a late successful_payment will not grant (T-50)
    if pay.state != "refunded":
        pay.state = "refunded"
        await _revoke_payment_grants(db, pay, "refund")
        pending = await db.scalar(select(Refund).where(Refund.payment_id == pay.id, Refund.state.in_(("requested", "unknown"))))
        if pending:
            pending.state, pending.completed_at = "succeeded", utcnow()
        else:
            db.add(Refund(payment_id=pay.id, request_key=f"external:{charge}", state="external", reason="Telegram orqali qaytarildi", completed_at=utcnow()))
        await emit(db, f"billing.refunded:{pay.id}", "billing.refunded", {"payment_id": pay.id, "user_id": pay.user_id})
    return pay


async def refund_payment(db: AsyncSession, actor: Actor, payment_id: int, reason: str, request_key: str) -> Refund:
    """Staff refund. Retrying with the same request_key never creates a second refund (T-51)."""
    actor.require("billing.refund")
    pay = await db.scalar(select(Payment).where(Payment.id == payment_id).with_for_update())
    if pay is None:
        raise NotFound("To'lov topilmadi")
    if not reason.strip():
        raise Invalid("Sabab kerak", code="reason_required")
    res = await db.execute(
        insert(Refund).values(payment_id=pay.id, request_key=request_key[:80], state="requested", initiated_by=actor.id, reason=reason[:1000]).on_conflict_do_nothing(index_elements=["request_key"]).returning(Refund.id)
    )
    rid = res.scalar()
    refund = await db.scalar(select(Refund).where(Refund.request_key == request_key[:80]))
    assert refund is not None
    if refund.payment_id != pay.id:
        raise Conflict("request_key boshqa to'lovga tegishli", code="key_reused")
    if refund.state in ("succeeded", "external"):
        return refund
    if rid is None and refund.state == "failed":
        refund.state = "requested"
    other = await db.scalar(select(Refund).where(Refund.payment_id == pay.id, Refund.state.in_(("succeeded", "external"))))
    if other:
        refund.state = "succeeded"
        return refund
    user = await db.get(User, pay.user_id)
    assert user is not None
    try:
        await get_telegram().call("refundStarPayment", user_id=user.telegram_user_id, telegram_payment_charge_id=pay.telegram_charge_id)
        ok = True
    except TelegramError as e:
        if "already" in e.description.lower():
            ok = True
        else:
            refund.state, refund.error = "failed", e.description[:500]
            await audit(db, actor, "billing.refund_failed", "payment", pay.id, reason=e.description)
            return refund
    except TelegramUncertain as e:
        # not recorded as refunded until verified (retry with the same key, or the refunded_payment update)
        refund.state, refund.error = "unknown", str(e)[:500]
        await audit(db, actor, "billing.refund_unknown", "payment", pay.id, reason=str(e))
        return refund
    if ok:
        refund.state, refund.completed_at = "succeeded", utcnow()
        await db.execute(insert(RefundedCharge).values(telegram_charge_id=pay.telegram_charge_id).on_conflict_do_nothing())
        pay.state = "refunded"
        await _revoke_payment_grants(db, pay, f"refund #{refund.id}")
        await audit(db, actor, "billing.refund", "payment", pay.id, reason=reason, after={"refund_id": refund.id})
        await emit(db, f"billing.refunded:{pay.id}", "billing.refunded", {"payment_id": pay.id, "user_id": pay.user_id})
    return refund


async def set_renewal(db: AsyncSession, user: User, subscription_id: int, cancel: bool) -> Subscription:
    """Cancel/resume auto-renewal (editUserStarSubscription). Paid period continues (T-45)."""
    sub = await db.scalar(select(Subscription).where(Subscription.id == subscription_id).with_for_update())
    if sub is None or sub.user_id != user.id:
        raise NotFound()
    await get_telegram().call("editUserStarSubscription", user_id=user.telegram_user_id, telegram_payment_charge_id=sub.first_charge_id, is_canceled=cancel)
    sub.renewal_state = "canceled" if cancel else "active"
    return sub


def subscription_dto(sub: Subscription, now: datetime | None = None) -> dict:
    now = now or utcnow()
    active = bool(sub.paid_until and sub.paid_until > now)
    if not active:
        text_ = "Premium muddati tugagan"
    elif sub.renewal_state == "canceled":
        text_ = f"Yangilanish o'chirilgan, {sub.paid_until:%d.%m.%Y} gacha faol"
    elif sub.renewal_state == "failed":
        text_ = f"Yangilash to'lovi o'tmadi, {sub.paid_until:%d.%m.%Y} gacha faol"
    else:
        text_ = "Premium faol"
    return {
        "id": sub.id,
        "renewal_state": sub.renewal_state,
        "paid_until": sub.paid_until.isoformat() if sub.paid_until else None,
        "active": active,
        "status_text": text_,
        "next_charge_at": sub.paid_until.isoformat() if active and sub.renewal_state == "active" and sub.paid_until else None,
    }


async def expire_stale_orders(db: AsyncSession) -> int:
    res = await db.execute(update(Order).where(Order.status.in_(("created", "pending")), Order.expires_at <= utcnow()).values(status="expired").returning(Order.id))
    return len(res.all())


async def billing_overview(db: AsyncSession, actor: Actor) -> dict:
    actor.require("billing.view")
    from sqlalchemy import func

    rows = (await db.execute(select(Payment.state, func.count(), func.coalesce(func.sum(Payment.amount), 0)).group_by(Payment.state))).all()
    review = (await db.scalars(select(Payment).where(Payment.state == "needs_review").order_by(Payment.id.desc()).limit(50))).all()
    unknown = (await db.scalars(select(Refund).where(Refund.state.in_(("unknown", "requested", "failed"))).order_by(Refund.id.desc()).limit(50))).all()
    return {
        "by_state": [{"state": r[0], "count": r[1], "stars": int(r[2])} for r in rows],
        "needs_review": [{"id": p.id, "user_id": p.user_id, "amount": p.amount, "reason": p.review_reason, "created_at": p.created_at.isoformat()} for p in review],
        "open_refunds": [{"id": r.id, "payment_id": r.payment_id, "state": r.state, "error": r.error} for r in unknown],
        "note": "Stars → so'm kursi va'da qilinmaydi",
    }

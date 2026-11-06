from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB, CurActor, Ents, limiter
from app.core.errors import Invalid
from app.models import Order, Payment, Subscription, SupportMessage, SupportTicket
from app.services import billing

router = APIRouter(tags=["billing"])


@router.get("/billing/products")
async def products(db: DB, work_id: int | None = None):
    return await billing.list_products(db, work_id)


class OrderIn(BaseModel):
    product_id: int


@router.post("/billing/orders")
async def create_order(body: OrderIn, db: DB, actor: CurActor, idempotency_key: Annotated[str | None, Header()] = None):
    limiter.hit(f"order:{actor.id}", 10, 60)
    if not idempotency_key:
        raise Invalid("Idempotency-Key sarlavhasi kerak", code="idempotency_required")
    order = await billing.create_order(db, actor.user, body.product_id, idempotency_key)
    return billing.order_dto(order)


@router.get("/billing/orders/{order_id}")
async def get_order(order_id: int, db: DB, actor: CurActor):
    return await billing.get_order_for_user(db, actor.user, order_id)


@router.get("/billing/subscriptions")
async def subscriptions(db: DB, actor: CurActor, ent: Ents):
    subs = (await db.scalars(select(Subscription).where(Subscription.user_id == actor.id).order_by(Subscription.id.desc()))).all()
    orders = (await db.scalars(select(Order).where(Order.user_id == actor.id).order_by(Order.id.desc()).limit(20))).all()
    pays = {p.order_id: p for p in (await db.scalars(select(Payment).where(Payment.user_id == actor.id))).all()}
    return {
        "premium": ent.premium,
        "premium_until": ent.premium_until.isoformat() if ent.premium_until else None,
        "subscriptions": [billing.subscription_dto(s) for s in subs],
        "orders": [billing.order_dto(o, pays.get(o.id)) for o in orders],
        "support_hint": "To'lov bo'yicha savol: botda /paysupport yoki «Yordam» bo'limi",
    }


@router.post("/billing/subscriptions/{sub_id}/cancel-renewal")
async def cancel_renewal(sub_id: int, db: DB, actor: CurActor):
    return billing.subscription_dto(await billing.set_renewal(db, actor.user, sub_id, True))


@router.post("/billing/subscriptions/{sub_id}/resume-renewal")
async def resume_renewal(sub_id: int, db: DB, actor: CurActor):
    return billing.subscription_dto(await billing.set_renewal(db, actor.user, sub_id, False))


class SupportIn(BaseModel):
    category: str = "payment"
    subject: str = Field("", max_length=160)
    body: str = Field(min_length=1, max_length=4000)
    order_id: int | None = None


@router.post("/billing/support")
@router.post("/support/tickets")
async def support(body: SupportIn, db: DB, actor: CurActor):
    limiter.hit(f"support:{actor.id}", 10, 3600)
    if body.category not in ("payment", "content", "account", "complaint", "other"):
        raise Invalid()
    order_id = None
    if body.order_id:
        o = await db.get(Order, body.order_id)
        order_id = o.id if o and o.user_id == actor.id else None
    t = SupportTicket(user_id=actor.id, category=body.category, subject=body.subject or body.body[:60], order_id=order_id)
    db.add(t)
    await db.flush()
    db.add(SupportMessage(ticket_id=t.id, author_user_id=actor.id, body=body.body))
    return {"id": t.id, "status": t.status}


@router.get("/support/tickets")
async def my_tickets(db: DB, actor: CurActor):
    rows = (await db.scalars(select(SupportTicket).where(SupportTicket.user_id == actor.id).order_by(SupportTicket.id.desc()))).all()
    out = []
    for t in rows:
        msgs = (await db.scalars(select(SupportMessage).where(SupportMessage.ticket_id == t.id).order_by(SupportMessage.id))).all()
        out.append({"id": t.id, "category": t.category, "subject": t.subject, "status": t.status, "messages": [{"body": m.body, "staff": m.is_staff, "at": m.created_at.isoformat()} for m in msgs]})
    return out


class RefundIn(BaseModel):
    reason: str
    request_key: str = Field(min_length=8, max_length=80)


@router.post("/admin/billing/payments/{payment_id}/refund")
async def refund(payment_id: int, body: RefundIn, db: DB, actor: CurActor):
    r = await billing.refund_payment(db, actor, payment_id, body.reason, body.request_key)
    return {"id": r.id, "state": r.state, "error": r.error}


@router.get("/admin/billing")
async def overview(db: DB, actor: CurActor):
    return await billing.billing_overview(db, actor)


class PriceIn(BaseModel):
    amount: int
    duration_days: int | None = None
    activate: bool = True


@router.post("/admin/billing/products/{product_id}/price")
async def set_price(product_id: int, body: PriceIn, db: DB, actor: CurActor):
    v = await billing.set_price(db, actor, product_id, body.amount, body.duration_days, body.activate)
    return {"version": v.version, "amount": v.amount}

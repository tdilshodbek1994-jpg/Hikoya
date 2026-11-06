from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped, utcnow


class Product(Base, Timestamped):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(48), unique=True)
    title: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    access_scope: Mapped[str] = mapped_column(String(16))  # premium | work
    scope_id: Mapped[int | None] = mapped_column(nullable=True)
    pricing_type: Mapped[str] = mapped_column(String(16))  # subscription | one_time
    active: Mapped[bool] = mapped_column(default=False)
    sort_order: Mapped[int] = mapped_column(default=0)


class ProductVersion(Base, Timestamped):
    __tablename__ = "product_versions"
    __table_args__ = (UniqueConstraint("product_id", "version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    version: Mapped[int]
    currency: Mapped[str] = mapped_column(String(8), default="XTR")
    amount: Mapped[int]  # integer Stars
    duration_days: Mapped[int | None] = mapped_column(nullable=True)
    active: Mapped[bool] = mapped_column(default=False)
    is_demo: Mapped[bool] = mapped_column(default=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class Order(Base, Timestamped):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("user_id", "idempotency_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    product_version_id: Mapped[int] = mapped_column(ForeignKey("product_versions.id"))
    snapshot: Mapped[dict]  # immutable terms at checkout time
    invoice_payload: Mapped[str] = mapped_column(String(128), unique=True)
    invoice_link: Mapped[str] = mapped_column(Text, default="")
    # created | pending | paid | expired | canceled | failed | superseded
    status: Mapped[str] = mapped_column(String(16), default="created")
    idempotency_key: Mapped[str] = mapped_column(String(80))
    scope_key: Mapped[str] = mapped_column(String(48))  # e.g. "premium" or "work:12"
    expires_at: Mapped[datetime]
    paid_at: Mapped[datetime | None] = mapped_column(nullable=True)


class PurchaseIntentLock(Base):
    """One row per (user, scope). Locked FOR UPDATE while creating orders / pre-checkout."""

    __tablename__ = "purchase_intent_locks"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(48), primary_key=True)
    active_order_id: Mapped[int | None] = mapped_column(nullable=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Subscription(Base, Timestamped):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    original_order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), unique=True)
    immutable_payload: Mapped[str] = mapped_column(String(128), unique=True)
    renewal_state: Mapped[str] = mapped_column(String(16), default="active")  # active | canceled | failed
    paid_until: Mapped[datetime | None] = mapped_column(nullable=True)
    first_charge_id: Mapped[str] = mapped_column(String(128), default="")
    last_charge_id: Mapped[str] = mapped_column(String(128), default="")
    last_provider_update_id: Mapped[int | None] = mapped_column(nullable=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow, onupdate=utcnow)


class Payment(Base, Timestamped):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True, index=True)
    subscription_id: Mapped[int | None] = mapped_column(ForeignKey("subscriptions.id"), nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    telegram_charge_id: Mapped[str] = mapped_column(String(128), unique=True)
    provider_charge_id: Mapped[str] = mapped_column(String(128), default="")
    invoice_payload: Mapped[str] = mapped_column(String(128))
    amount: Mapped[int]
    currency: Mapped[str] = mapped_column(String(8))
    # confirmed | refunded | needs_review
    state: Mapped[str] = mapped_column(String(16), default="confirmed")
    is_recurring: Mapped[bool] = mapped_column(default=False)
    is_first_recurring: Mapped[bool] = mapped_column(default=False)
    subscription_expiration_date: Mapped[datetime | None] = mapped_column(nullable=True)
    review_reason: Mapped[str] = mapped_column(Text, default="")
    confirmed_at: Mapped[datetime] = mapped_column(server_default=func.now())


class TelegramUpdate(Base):
    """Every update_id is processed at most once (webhook retries, double delivery)."""

    __tablename__ = "telegram_updates"

    update_id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    kind: Mapped[str] = mapped_column(String(32))
    received_at: Mapped[datetime] = mapped_column(server_default=func.now())
    processed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict | None] = mapped_column(nullable=True)  # only for payment-related updates


class Refund(Base, Timestamped):
    __tablename__ = "refunds"

    id: Mapped[int] = mapped_column(primary_key=True)
    payment_id: Mapped[int] = mapped_column(ForeignKey("payments.id"), index=True)
    request_key: Mapped[str] = mapped_column(String(80), unique=True)
    # requested | succeeded | failed | unknown | external (refund came from Telegram, not us)
    state: Mapped[str] = mapped_column(String(16), default="requested")
    initiated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    completed_at: Mapped[datetime | None] = mapped_column(nullable=True)


class RefundedCharge(Base):
    """Tombstone so that a late successful_payment never re-activates a refunded charge (T-50)."""

    __tablename__ = "refunded_charges"

    telegram_charge_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    refunded_at: Mapped[datetime] = mapped_column(server_default=func.now())


class EntitlementGrant(Base, Timestamped):
    __tablename__ = "entitlement_grants"
    __table_args__ = (
        UniqueConstraint("source_type", "source_id", "scope_type", "scope_id"),
        Index("ix_grants_user_scope", "user_id", "scope_type", "scope_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    source_type: Mapped[str] = mapped_column(String(16))  # payment | subscription | gift | manual
    source_id: Mapped[str] = mapped_column(String(64))
    scope_type: Mapped[str] = mapped_column(String(16))  # premium | work
    scope_id: Mapped[int] = mapped_column(default=0)
    starts_at: Mapped[datetime] = mapped_column(server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
    revoke_reason: Mapped[str] = mapped_column(Text, default="")
    terms: Mapped[dict] = mapped_column(default=dict)  # snapshot of purchase terms


class SupportTicket(Base, Timestamped):
    __tablename__ = "support_tickets"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    category: Mapped[str] = mapped_column(String(16))  # payment | content | account | complaint | other
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id"), nullable=True)
    subject: Mapped[str] = mapped_column(String(160), default="")
    status: Mapped[str] = mapped_column(String(16), default="open")  # open|in_progress|resolved|closed
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow, onupdate=utcnow)


class SupportMessage(Base, Timestamped):
    __tablename__ = "support_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("support_tickets.id", ondelete="CASCADE"), index=True)
    author_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    is_staff: Mapped[bool] = mapped_column(default=False)
    body: Mapped[str] = mapped_column(Text)

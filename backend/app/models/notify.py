from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped


class NotificationPreference(Base):
    __tablename__ = "notification_preferences"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    mode: Mapped[str] = mapped_column(String(16), default="instant")  # instant | digest
    quiet_start: Mapped[str] = mapped_column(String(5), default="22:00")
    quiet_end: Mapped[str] = mapped_column(String(5), default="09:00")
    timezone: Mapped[str] = mapped_column(String(48), default="Asia/Tashkent")
    disabled_types: Mapped[list] = mapped_column(default=list)


class Notification(Base, Timestamped):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user", "user_id", "read_at", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # new_chapter | new_work | comment_reply | edit_request | billing | system | work_completed
    type: Mapped[str] = mapped_column(String(24))
    dedupe_key: Mapped[str] = mapped_column(String(160), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(64), default="")  # startapp-style param, e.g. w_ABC
    payload: Mapped[dict] = mapped_column(default=dict)
    read_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Delivery(Base, Timestamped):
    __tablename__ = "deliveries"
    __table_args__ = (Index("ix_deliveries_due", "status", "next_attempt_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    notification_id: Mapped[int] = mapped_column(ForeignKey("notifications.id", ondelete="CASCADE"), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    channel: Mapped[str] = mapped_column(String(16), default="telegram")
    # pending | sent | failed | skipped | uncertain | digested
    status: Mapped[str] = mapped_column(String(16), default="pending")
    is_service: Mapped[bool] = mapped_column(default=False)  # payment confirmations ignore quiet hours
    attempts: Mapped[int] = mapped_column(default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_error: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(nullable=True)


class OutboxEvent(Base, Timestamped):
    __tablename__ = "outbox_events"
    __table_args__ = (Index("ix_outbox_pending", "processed_at", "id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_key: Mapped[str] = mapped_column(String(160), unique=True)
    type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(default=dict)
    processed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    attempts: Mapped[int] = mapped_column(default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")


class TelegramOutbox(Base, Timestamped):
    """Messages the app wants the bot to send (used when telegram_enabled is false, and as a log)."""

    __tablename__ = "telegram_calls"

    id: Mapped[int] = mapped_column(primary_key=True)
    method: Mapped[str] = mapped_column(String(48))
    params: Mapped[dict] = mapped_column(default=dict)
    ok: Mapped[bool] = mapped_column(default=True)
    response: Mapped[dict] = mapped_column(default=dict)
    error: Mapped[str] = mapped_column(Text, default="")

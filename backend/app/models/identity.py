from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped


class User(Base, Timestamped):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_user_id: Mapped[int] = mapped_column(unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    language: Mapped[str] = mapped_column(String(8), default="uz")
    script: Mapped[str] = mapped_column(String(8), default="latn")  # latn | cyrl
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | blocked
    is_test: Mapped[bool] = mapped_column(default=False)
    onboarding_done: Mapped[bool] = mapped_column(default=False)
    favorite_genre_ids: Mapped[list] = mapped_column(default=list)
    reader_settings: Mapped[dict] = mapped_column(default=dict)
    only_completed: Mapped[bool] = mapped_column(default=False)
    daily_goal_minutes: Mapped[int | None] = mapped_column(nullable=True)
    bot_started: Mapped[bool] = mapped_column(default=False)
    bot_blocked: Mapped[bool] = mapped_column(default=False)
    bot_messages_allowed: Mapped[bool] = mapped_column(default=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Session(Base, Timestamped):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)
    device_label: Mapped[str] = mapped_column(String(128), default="")


class RoleGrant(Base):
    """A role or a single permission given to a user, globally or for one object."""

    __tablename__ = "role_grants"
    __table_args__ = (Index("ix_role_grants_active", "user_id", "revoked_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    permission: Mapped[str | None] = mapped_column(String(64), nullable=True)
    scope_type: Mapped[str] = mapped_column(String(16), default="global")  # global | work
    scope_id: Mapped[int | None] = mapped_column(nullable=True)
    granted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    granted_at: Mapped[datetime] = mapped_column(server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)


class AuditLog(Base, Timestamped):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    on_behalf_of_author_id: Mapped[int | None] = mapped_column(nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[str] = mapped_column(String(64))
    before: Mapped[dict | None] = mapped_column(nullable=True)
    after: Mapped[dict | None] = mapped_column(nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    request_id: Mapped[str] = mapped_column(String(64), default="")


class AuthorProfile(Base, Timestamped):
    __tablename__ = "author_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), unique=True, nullable=True)
    pen_name: Mapped[str] = mapped_column(String(128))
    slug: Mapped[str] = mapped_column(String(128), unique=True)
    bio: Mapped[str] = mapped_column(Text, default="")
    avatar_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    verification_status: Mapped[str] = mapped_column(String(16), default="none")  # none | verified
    publish_policy: Mapped[str] = mapped_column(String(16), default="review")  # review | trusted
    editorial_featured: Mapped[bool] = mapped_column(default=False)
    next_release_note: Mapped[str] = mapped_column(Text, default="")
    is_demo: Mapped[bool] = mapped_column(default=False)
    search_text: Mapped[str] = mapped_column(Text, default="")


class AuthorMembership(Base):
    """Extra users that may manage an author profile (co-authors, agents)."""

    __tablename__ = "author_memberships"
    __table_args__ = (UniqueConstraint("author_id", "user_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("author_profiles.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(16), default="member")


class BotDialog(Base):
    """Persisted bot conversation state, so a restart resumes the flow (T-28)."""

    __tablename__ = "bot_dialogs"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    flow: Mapped[str] = mapped_column(String(32), default="")
    step: Mapped[str] = mapped_column(String(32), default="")
    data: Mapped[dict] = mapped_column(default=dict)
    active_work_id: Mapped[int | None] = mapped_column(nullable=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(default=dict)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

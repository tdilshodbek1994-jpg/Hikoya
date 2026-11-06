from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped


class AIRequest(Base, Timestamped):
    """Every AI call is logged: who, what kind, result, tokens. Used for per-user daily limits."""

    __tablename__ = "ai_requests"
    __table_args__ = (Index("ix_ai_requests_user_day", "user_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(24))  # synopsis | proofread | recap | search
    work_id: Mapped[int | None] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), nullable=True)
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok | refused | error
    model: Mapped[str] = mapped_column(String(64), default="")
    result: Mapped[dict] = mapped_column(default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    input_tokens: Mapped[int] = mapped_column(default=0)
    output_tokens: Mapped[int] = mapped_column(default=0)
    decided_at: Mapped[datetime | None] = mapped_column(nullable=True)  # proofread suggestions accepted/rejected

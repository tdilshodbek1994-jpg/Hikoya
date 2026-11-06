from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, Float, ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped


class ReadingSession(Base):
    __tablename__ = "reading_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    public_id: Mapped[str] = mapped_column(String(40), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"))
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    active_seconds: Mapped[float] = mapped_column(Float, default=0)
    blocks_seen: Mapped[list] = mapped_column(default=list)
    total_blocks: Mapped[int] = mapped_column(default=0)
    is_preview: Mapped[bool] = mapped_column(default=False)
    qualified: Mapped[bool] = mapped_column(default=False)
    flagged: Mapped[str] = mapped_column(String(32), default="")


class ReadingProgress(Base):
    """current_* is the reader's last conscious position; furthest_* never decreases."""

    __tablename__ = "reading_progress"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"))
    chapter_revision_id: Mapped[int | None] = mapped_column(nullable=True)
    current_block_id: Mapped[str] = mapped_column(String(32), default="")
    current_offset: Mapped[float] = mapped_column(Float, default=0)
    current_ratio: Mapped[float] = mapped_column(Float, default=0)
    furthest_chapter_id: Mapped[int | None] = mapped_column(nullable=True)
    furthest_sort_key: Mapped[float] = mapped_column(Float, default=0)
    furthest_ratio: Mapped[float] = mapped_column(Float, default=0)
    completion_state: Mapped[str] = mapped_column(String(16), default="reading")  # reading | completed
    last_sequence: Mapped[int] = mapped_column(default=0)
    device_id: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ChapterCompletion(Base):
    __tablename__ = "chapter_completions"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), index=True)
    completed_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ReadingEvent(Base):
    __tablename__ = "reading_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("reading_sessions.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    sequence: Mapped[int]
    event_type: Mapped[str] = mapped_column(String(24))  # heartbeat | blocks | position | complete
    position: Mapped[dict] = mapped_column(default=dict)
    client_ts: Mapped[datetime | None] = mapped_column(nullable=True)
    received_at: Mapped[datetime] = mapped_column(server_default=func.now())


class QualifiedRead(Base):
    __tablename__ = "qualified_reads"
    __table_args__ = (
        UniqueConstraint("user_id", "work_id", "local_date"),
        Index("ix_qualified_reads_period", "local_date", "work_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    local_date: Mapped[date] = mapped_column(Date)
    qualified_at: Mapped[datetime] = mapped_column(server_default=func.now())
    reason_version: Mapped[str] = mapped_column(String(16), default="qr-v1")
    source: Mapped[str] = mapped_column(String(16), default="")  # e.g. "story" if opened from storis


class Bookmark(Base, Timestamped):
    __tablename__ = "bookmarks"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"))
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    block_id: Mapped[str] = mapped_column(String(32))
    offset: Mapped[float] = mapped_column(Float, default=0)
    quote: Mapped[str] = mapped_column(Text, default="")


class ReaderHighlight(Base, Timestamped):
    """A quote marked by a reader inside a chapter (not to be confused with story highlights)."""

    __tablename__ = "reader_highlights"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"))
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    block_id: Mapped[str] = mapped_column(String(32))
    start: Mapped[int] = mapped_column(default=0)
    end: Mapped[int] = mapped_column(default=0)
    quote: Mapped[str] = mapped_column(Text)
    color: Mapped[str] = mapped_column(String(16), default="yellow")


class PrivateNote(Base, Timestamped):
    __tablename__ = "private_notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    block_id: Mapped[str] = mapped_column(String(32), default="")
    quote: Mapped[str] = mapped_column(Text, default="")
    text: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class LibraryItem(Base):
    __tablename__ = "library_items"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(server_default=func.now())


class UserCollection(Base, Timestamped):
    __tablename__ = "user_collections"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(80))
    is_private: Mapped[bool] = mapped_column(default=True)


class UserCollectionItem(Base):
    __tablename__ = "user_collection_items"

    collection_id: Mapped[int] = mapped_column(ForeignKey("user_collections.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    sort_key: Mapped[int] = mapped_column(default=0)
    added_at: Mapped[datetime] = mapped_column(server_default=func.now())


class RecentSearch(Base, Timestamped):
    __tablename__ = "recent_searches"
    __table_args__ = (UniqueConstraint("user_id", "query"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    query: Mapped[str] = mapped_column(String(120))


class Dismissal(Base, Timestamped):
    """«Qiziq emas» (work) or «Bunday mavzuni kamaytirish» (genre/tag)."""

    __tablename__ = "dismissals"
    __table_args__ = (UniqueConstraint("user_id", "target_type", "target_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(16))  # work | genre | tag
    target_id: Mapped[int]

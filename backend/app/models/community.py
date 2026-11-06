from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped, utcnow


class Like(Base, Timestamped):
    __tablename__ = "likes"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)


class Thanks(Base, Timestamped):
    __tablename__ = "thanks"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    reason: Mapped[str] = mapped_column(String(24), default="")  # touched | useful | waiting
    active: Mapped[bool] = mapped_column(default=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow, onupdate=utcnow)


class Follow(Base, Timestamped):
    __tablename__ = "follows"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    target_type: Mapped[str] = mapped_column(String(16), primary_key=True)  # author | work
    target_id: Mapped[int] = mapped_column(primary_key=True)
    notify_on_complete: Mapped[bool] = mapped_column(default=False)


class Comment(Base, Timestamped):
    __tablename__ = "comments"
    __table_args__ = (
        Index("ix_comments_thread", "work_id", "chapter_id", "status", "created_at"),
        UniqueConstraint("user_id", "client_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("comments.id", ondelete="CASCADE"), nullable=True)
    body: Mapped[str] = mapped_column(Text)
    spoiler: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(String(16), default="published")  # published|pending|hidden|deleted
    is_author_reply: Mapped[bool] = mapped_column(default=False)
    pinned: Mapped[bool] = mapped_column(default=False)
    helpful_count: Mapped[int] = mapped_column(default=0)
    edited_at: Mapped[datetime | None] = mapped_column(nullable=True)
    revision: Mapped[int] = mapped_column(default=1)
    client_key: Mapped[str] = mapped_column(String(64))
    # inline comment: anchored to a stable block id of the chapter, with the quoted fragment
    block_id: Mapped[str] = mapped_column(String(32), default="")
    quote: Mapped[str] = mapped_column(Text, default="")


class CommentVote(Base):
    __tablename__ = "comment_votes"

    comment_id: Mapped[int] = mapped_column(ForeignKey("comments.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)


class Report(Base, Timestamped):
    """A complaint about a comment, story or public profile."""

    __tablename__ = "reports"
    __table_args__ = (UniqueConstraint("reporter_id", "target_type", "target_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[str] = mapped_column(String(16))  # comment | story | author | work
    target_id: Mapped[int]
    reporter_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    reason: Mapped[str] = mapped_column(String(24))  # spam|abuse|ads|personal_data|plagiarism|other
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | resolved | rejected
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolution: Mapped[str] = mapped_column(Text, default="")
    reviewed_at: Mapped[datetime | None] = mapped_column(nullable=True)


class ModerationAction(Base, Timestamped):
    __tablename__ = "moderation_actions"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_type: Mapped[str] = mapped_column(String(16))
    target_id: Mapped[int]
    moderator_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(16))  # hide | restore | warn | restrict | approve
    reason: Mapped[str] = mapped_column(Text)
    appeal_status: Mapped[str] = mapped_column(String(16), default="none")  # none|requested|upheld|reverted
    appeal_note: Mapped[str] = mapped_column(Text, default="")


class UserRestriction(Base, Timestamped):
    __tablename__ = "user_restrictions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="comment")
    until: Mapped[datetime]
    reason: Mapped[str] = mapped_column(Text)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))


class AuthorStory(Base, Timestamped):
    __tablename__ = "author_stories"
    __table_args__ = (Index("ix_author_stories_feed", "status", "expires_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("author_profiles.id", ondelete="CASCADE"), index=True)
    caption: Mapped[str] = mapped_column(Text, default="")
    publish_at: Mapped[datetime | None] = mapped_column(nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    duration_hours: Mapped[int] = mapped_column(default=24)
    audience: Mapped[str] = mapped_column(String(16), default="all")  # all | followers
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|pending|published|rejected|archived
    moderation_note: Mapped[str] = mapped_column(Text, default="")
    revision: Mapped[int] = mapped_column(default=1)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class StoryFrame(Base):
    __tablename__ = "story_frames"

    id: Mapped[int] = mapped_column(primary_key=True)
    story_id: Mapped[int] = mapped_column(ForeignKey("author_stories.id", ondelete="CASCADE"), index=True)
    sort_key: Mapped[int] = mapped_column(default=0)
    kind: Mapped[str] = mapped_column(String(16))  # text | image | video | quote | chapter | poll
    media_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    background: Mapped[str] = mapped_column(String(32), default="violet")
    subtitles: Mapped[str] = mapped_column(Text, default="")
    action_type: Mapped[str] = mapped_column(String(16), default="")  # read | new_chapter | follow | vote
    linked_work_id: Mapped[int | None] = mapped_column(ForeignKey("works.id", ondelete="SET NULL"), nullable=True)
    linked_chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    audience: Mapped[str] = mapped_column(String(16), default="all")  # all | premium
    poll_options: Mapped[list] = mapped_column(default=list)
    duration_ms: Mapped[int] = mapped_column(default=6000)


class StoryView(Base):
    __tablename__ = "story_views"

    frame_id: Mapped[int] = mapped_column(ForeignKey("story_frames.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    story_id: Mapped[int] = mapped_column(ForeignKey("author_stories.id", ondelete="CASCADE"), index=True)
    impressions: Mapped[int] = mapped_column(default=1)
    completed: Mapped[bool] = mapped_column(default=False)
    viewed_at: Mapped[datetime] = mapped_column(server_default=func.now())


class StoryAction(Base, Timestamped):
    __tablename__ = "story_actions"
    __table_args__ = (UniqueConstraint("user_id", "frame_id", "action", "client_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    story_id: Mapped[int] = mapped_column(ForeignKey("author_stories.id", ondelete="CASCADE"), index=True)
    frame_id: Mapped[int] = mapped_column(ForeignKey("story_frames.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    action: Mapped[str] = mapped_column(String(16))  # skip | link_click | vote | follow | start_work
    value: Mapped[str] = mapped_column(String(64), default="")
    client_key: Mapped[str] = mapped_column(String(64), default="")


class StoryHighlight(Base, Timestamped):
    __tablename__ = "story_highlights"

    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("author_profiles.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(48))
    sort_key: Mapped[int] = mapped_column(default=0)


class StoryHighlightItem(Base):
    __tablename__ = "story_highlight_items"

    highlight_id: Mapped[int] = mapped_column(ForeignKey("story_highlights.id", ondelete="CASCADE"), primary_key=True)
    frame_id: Mapped[int] = mapped_column(ForeignKey("story_frames.id", ondelete="CASCADE"), primary_key=True)
    sort_key: Mapped[int] = mapped_column(default=0)


class ShareLink(Base, Timestamped):
    """One share action: who shared what, through which channel. Its id travels in the deep link."""

    __tablename__ = "share_links"
    __table_args__ = (Index("ix_share_links_target", "target_type", "target_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    target_type: Mapped[str] = mapped_column(String(16))  # work | chapter | author | story | app
    target_id: Mapped[int] = mapped_column(default=0)
    channel: Mapped[str] = mapped_column(String(16), default="link")  # message | story | link | inline | native
    opens: Mapped[int] = mapped_column(default=0)
    new_users: Mapped[int] = mapped_column(default=0)


class ShareOpen(Base):
    """A person who opened the app through a share link (counted once per person and link)."""

    __tablename__ = "share_opens"

    share_id: Mapped[int] = mapped_column(ForeignKey("share_links.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    is_new_user: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

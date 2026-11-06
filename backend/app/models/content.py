from __future__ import annotations

from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, Timestamped, utcnow


class Genre(Base):
    __tablename__ = "genres"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name_latn: Mapped[str] = mapped_column(String(64))
    name_cyrl: Mapped[str] = mapped_column(String(64))
    name_ru: Mapped[str] = mapped_column(String(64), default="")
    synonyms: Mapped[list] = mapped_column(default=list)
    cover_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    emoji: Mapped[str] = mapped_column(String(8), default="")
    sort_order: Mapped[int] = mapped_column(default=0)
    active: Mapped[bool] = mapped_column(default=True)


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name_latn: Mapped[str] = mapped_column(String(64))
    name_cyrl: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16), default="general")  # general | mood | content
    active: Mapped[bool] = mapped_column(default=True)


class Work(Base, Timestamped):
    __tablename__ = "works"
    __table_args__ = (
        Index("ix_works_catalog", "editorial_state", "visibility", "published_at"),
        # trigram index for normalised search (ILIKE / similarity / word_similarity)
        Index("ix_works_search_trgm", "search_text", postgresql_using="gin", postgresql_ops={"search_text": "gin_trgm_ops"}),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    short_code: Mapped[str] = mapped_column(String(16), unique=True)
    slug: Mapped[str] = mapped_column(String(160))
    title: Mapped[str] = mapped_column(String(200))
    synopsis: Mapped[str] = mapped_column(Text, default="")
    primary_author_id: Mapped[int] = mapped_column(ForeignKey("author_profiles.id"), index=True)
    cover_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    primary_genre_id: Mapped[int | None] = mapped_column(ForeignKey("genres.id"), nullable=True)
    content_language: Mapped[str] = mapped_column(String(8), default="uz")
    script: Mapped[str] = mapped_column(String(8), default="latn")
    format: Mapped[str] = mapped_column(String(16), default="short")  # short|novella|novel|series|diary
    # draft | in_review | changes_requested | approved | scheduled | published
    # | unpublished | delisted | archived | suspended
    editorial_state: Mapped[str] = mapped_column(String(24), default="draft")
    completion_state: Mapped[str] = mapped_column(String(16), default="ongoing")  # ongoing|completed|paused
    access_policy: Mapped[str] = mapped_column(String(24), default="FREE")
    visibility: Mapped[str] = mapped_column(String(16), default="public")  # public | delisted | hidden
    suspended_reason: Mapped[str] = mapped_column(Text, default="")
    archived_at: Mapped[datetime | None] = mapped_column(nullable=True)
    comments_policy: Mapped[str] = mapped_column(String(16), default="open")
    content_flags: Mapped[dict] = mapped_column(default=dict)  # age_rating, author_claim, ...
    planned_chapters: Mapped[int | None] = mapped_column(nullable=True)
    next_release_at: Mapped[datetime | None] = mapped_column(nullable=True)
    next_release_note: Mapped[str] = mapped_column(Text, default="")
    recap_note: Mapped[str] = mapped_column(Text, default="")
    is_demo: Mapped[bool] = mapped_column(default=False)
    search_text: Mapped[str] = mapped_column(Text, default="")
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow, onupdate=utcnow)
    published_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_chapter_published_at: Mapped[datetime | None] = mapped_column(nullable=True)
    # Denormalised public counters (recomputable from source tables).
    chapters_published: Mapped[int] = mapped_column(default=0)
    words_published: Mapped[int] = mapped_column(default=0)
    has_audio: Mapped[bool] = mapped_column(default=False)
    likes_count: Mapped[int] = mapped_column(default=0)
    thanks_count: Mapped[int] = mapped_column(default=0)
    comments_count: Mapped[int] = mapped_column(default=0)
    version: Mapped[int] = mapped_column(default=1)


class WorkGenre(Base):
    __tablename__ = "work_genres"

    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    genre_id: Mapped[int] = mapped_column(ForeignKey("genres.id", ondelete="CASCADE"), primary_key=True)
    is_primary: Mapped[bool] = mapped_column(default=False)


class WorkTag(Base):
    __tablename__ = "work_tags"

    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)


class WorkContributor(Base):
    __tablename__ = "work_contributors"
    __table_args__ = (UniqueConstraint("work_id", "author_id", "contribution_type"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("author_profiles.id"))
    contribution_type: Mapped[str] = mapped_column(String(16), default="author")  # author|coauthor|translator
    display_order: Mapped[int] = mapped_column(default=0)


class Chapter(Base, Timestamped):
    __tablename__ = "chapters"
    __table_args__ = (Index("ix_chapters_work_sort", "work_id", "sort_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    stable_key: Mapped[str] = mapped_column(String(32))
    sort_key: Mapped[float] = mapped_column(Float)
    title: Mapped[str] = mapped_column(String(200), default="")
    editorial_state: Mapped[str] = mapped_column(String(24), default="draft")
    published_revision_id: Mapped[int | None] = mapped_column(nullable=True)
    draft_revision_id: Mapped[int | None] = mapped_column(nullable=True)
    access_override: Mapped[str] = mapped_column(String(16), default="inherit")
    free_after_at: Mapped[datetime | None] = mapped_column(nullable=True)
    release_at: Mapped[datetime | None] = mapped_column(nullable=True)
    preview_blocks: Mapped[int] = mapped_column(default=3)
    # «Qayerda to'xtagandim?» — author-written recap, shown only to readers who finished this chapter
    recap: Mapped[str] = mapped_column(Text, default="")
    # audio ↔ text sync at block level: [{"bid": "...", "t": seconds}, ...] sorted by t
    audio_sync: Mapped[list] = mapped_column(default=list)
    published_at: Mapped[datetime | None] = mapped_column(nullable=True)
    words: Mapped[int] = mapped_column(default=0)
    has_audio: Mapped[bool] = mapped_column(default=False)
    is_deleted: Mapped[bool] = mapped_column(default=False)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow, onupdate=utcnow)


class ChapterRevision(Base, Timestamped):
    """Immutable text revision. Never updated after insert."""

    __tablename__ = "chapter_revisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), index=True)
    parent_revision_id: Mapped[int | None] = mapped_column(nullable=True)
    content_json: Mapped[dict]
    plain_text_for_index: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str] = mapped_column(String(64))
    editor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    change_note: Mapped[str] = mapped_column(Text, default="")
    word_count: Mapped[int] = mapped_column(default=0)
    block_ids: Mapped[list] = mapped_column(default=list)


class EditorialReview(Base, Timestamped):
    __tablename__ = "editorial_reviews"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    submitted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    reviewer_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    decision: Mapped[str] = mapped_column(String(24), default="pending")  # pending|approved|changes_requested
    note: Mapped[str] = mapped_column(Text, default="")
    decided_at: Mapped[datetime | None] = mapped_column(nullable=True)


class PublishJob(Base, Timestamped):
    __tablename__ = "publish_jobs"
    __table_args__ = (Index("ix_publish_jobs_due", "status", "run_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    access_snapshot: Mapped[dict] = mapped_column(default=dict)
    run_at: Mapped[datetime]
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|running|done|failed|canceled
    job_version: Mapped[int] = mapped_column(default=1)
    attempts: Mapped[int] = mapped_column(default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


class EditorNote(Base, Timestamped):
    __tablename__ = "editor_notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), index=True)
    revision_id: Mapped[int | None] = mapped_column(nullable=True)
    block_id: Mapped[str] = mapped_column(String(32), default="")
    author_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)
    resolved_at: Mapped[datetime | None] = mapped_column(nullable=True)


class ContentIssue(Base, Timestamped):
    """Reader-reported typo/error bound to an exact block of a revision."""

    __tablename__ = "content_issues"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"))
    revision_id: Mapped[int]
    block_id: Mapped[str] = mapped_column(String(32))
    quote: Mapped[str] = mapped_column(Text, default="")
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open")  # open|accepted|rejected


class Asset(Base, Timestamped):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    original_name: Mapped[str] = mapped_column(String(255), default="")
    mime: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(16))  # image|text|docx|pdf|audio|video
    size_bytes: Mapped[int]
    checksum: Mapped[str] = mapped_column(String(64), index=True)
    storage_key: Mapped[str] = mapped_column(String(255))
    visibility: Mapped[str] = mapped_column(String(16), default="private")  # public | private
    processing_state: Mapped[str] = mapped_column(String(16), default="ready")  # pending|ready|failed
    meta: Mapped[dict] = mapped_column(default=dict)  # width/height/duration


class AssetLink(Base):
    __tablename__ = "asset_links"
    __table_args__ = (Index("ix_asset_links_target", "target_type", "target_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"))
    target_type: Mapped[str] = mapped_column(String(16))  # work | chapter | story_frame | author
    target_id: Mapped[int]
    target_revision_id: Mapped[int | None] = mapped_column(nullable=True)
    purpose: Mapped[str] = mapped_column(String(16))  # cover|attachment|audio|image|story_media|avatar
    title: Mapped[str] = mapped_column(String(200), default="")
    access_policy: Mapped[str] = mapped_column(String(16), default="inherit")  # public | inherit
    download_allowed: Mapped[bool] = mapped_column(default=False)
    sort_order: Mapped[int] = mapped_column(default=0)


class ImportJob(Base, Timestamped):
    __tablename__ = "import_jobs"
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    source_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    target_work_id: Mapped[int | None] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), nullable=True)
    parser_version: Mapped[str] = mapped_column(String(16), default="1")
    status: Mapped[str] = mapped_column(String(16), default="parsed")  # parsed|applied|failed|discarded
    report: Mapped[dict] = mapped_column(default=dict)
    proposed: Mapped[list] = mapped_column(default=list)  # proposed chapters (title + content_json)
    created_chapters: Mapped[list] = mapped_column(default=list)
    checksum: Mapped[str] = mapped_column(String(64), default="")
    idempotency_key: Mapped[str] = mapped_column(String(80))


class HomeSection(Base):
    __tablename__ = "home_sections"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(48), unique=True)
    # stories | genres | continue | editorial | top | for_you | new_chapters | premium | rail
    kind: Mapped[str] = mapped_column(String(24))
    title_latn: Mapped[str] = mapped_column(String(120), default="")
    title_cyrl: Mapped[str] = mapped_column(String(120), default="")
    sort_order: Mapped[int] = mapped_column(default=0)
    active: Mapped[bool] = mapped_column(default=True)
    starts_at: Mapped[datetime | None] = mapped_column(nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(nullable=True)
    max_items: Mapped[int] = mapped_column(default=12)
    filter: Mapped[dict] = mapped_column(default=dict)
    allow_duplicates: Mapped[bool] = mapped_column(default=False)


class CuratedCollection(Base, Timestamped):
    __tablename__ = "curated_collections"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(default=True)


class CuratedItem(Base):
    __tablename__ = "curated_items"
    __table_args__ = (UniqueConstraint("collection_id", "work_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    collection_id: Mapped[int] = mapped_column(ForeignKey("curated_collections.id", ondelete="CASCADE"))
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"))
    sort_key: Mapped[int] = mapped_column(default=0)
    reason: Mapped[str] = mapped_column(Text, default="")  # «Nega tavsiya qilinyapti?»
    sponsored: Mapped[bool] = mapped_column(default=False)  # shown as «Homiylik»


class RankingSnapshot(Base):
    __tablename__ = "ranking_snapshots"
    __table_args__ = (Index("ix_ranking_lookup", "metric", "period", "genre_id", "computed_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    metric: Mapped[str] = mapped_column(String(24))  # most_read | trend | thanks
    period: Mapped[str] = mapped_column(String(16))  # today | week | month | all
    period_start: Mapped[datetime | None] = mapped_column(nullable=True)
    genre_id: Mapped[int | None] = mapped_column(nullable=True)
    formula_version: Mapped[str] = mapped_column(String(16))
    computed_at: Mapped[datetime] = mapped_column(server_default=func.now())
    items: Mapped[list] = mapped_column(default=list)


class Character(Base, Timestamped):
    """Character card. Hidden until the reader has read ``reveal_chapter_id`` (no spoilers)."""

    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    avatar_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    reveal_chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    sort_order: Mapped[int] = mapped_column(default=0)
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), default=utcnow, onupdate=utcnow)


class BetaReaderGrant(Base, Timestamped):
    """Invite to read unpublished drafts and leave feedback. Beta reads never count in stats."""

    __tablename__ = "beta_reader_grants"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_id: Mapped[int] = mapped_column(ForeignKey("works.id", ondelete="CASCADE"), index=True)
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)  # None = all chapters
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    token: Mapped[str] = mapped_column(String(48), unique=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    expires_at: Mapped[datetime]
    redeemed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)


class ChapterChoice(Base, Timestamped):
    """Branching story: a choice at the end of a chapter that leads to another chapter of the same work."""

    __tablename__ = "chapter_choices"
    __table_args__ = (UniqueConstraint("chapter_id", "target_chapter_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"), index=True)
    target_chapter_id: Mapped[int] = mapped_column(ForeignKey("chapters.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(120))
    sort_order: Mapped[int] = mapped_column(default=0)

from __future__ import annotations

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import OutboxEvent


async def emit(db: AsyncSession, event_key: str, type_: str, payload: dict) -> None:
    """Create an internal event inside the caller's transaction. Same key → created once."""
    await db.execute(
        insert(OutboxEvent)
        .values(event_key=event_key[:160], type=type_, payload=payload)
        .on_conflict_do_nothing(index_elements=["event_key"])
    )

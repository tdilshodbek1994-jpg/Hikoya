from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import RateLimited, Unauthorized
from app.db import sessionmaker
from app.services.access import Entitlements, load_entitlements
from app.services.identity import Actor, load_actor, resolve_session


async def get_db() -> AsyncIterator[AsyncSession]:
    """One transaction per request: committed on success, rolled back on any error."""
    async with sessionmaker()() as db:
        try:
            yield db
            await db.commit()
        except BaseException:
            await db.rollback()
            raise


DB = Annotated[AsyncSession, Depends(get_db)]


def _bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token.strip()


async def optional_actor(request: Request, db: DB, authorization: Annotated[str | None, Header()] = None) -> Actor | None:
    token = _bearer(authorization)
    if not token:
        return None
    user, sess = await resolve_session(db, token)
    request.state.session_id = sess.id
    # roles are re-read on every request: a revoked role stops working immediately (T-37)
    return await load_actor(db, user, getattr(request.state, "request_id", ""))


async def require_actor(actor: Annotated[Actor | None, Depends(optional_actor)]) -> Actor:
    if actor is None:
        raise Unauthorized("Kirish talab qilinadi", code="auth_required")
    return actor


OptActor = Annotated[Actor | None, Depends(optional_actor)]
CurActor = Annotated[Actor, Depends(require_actor)]


async def entitlements(db: DB, actor: OptActor) -> Entitlements:
    return await load_entitlements(db, actor.id if actor else None)


Ents = Annotated[Entitlements, Depends(entitlements)]


class SimpleRateLimiter:
    """In-process sliding-window limiter (per user+bucket). Redis is not required for correctness."""

    def __init__(self):
        import time

        self._t = time.monotonic
        self._hits: dict[str, list[float]] = {}

    def hit(self, key: str, limit: int, window: float) -> None:
        now = self._t()
        arr = [t for t in self._hits.get(key, []) if now - t < window]
        if len(arr) >= limit:
            raise RateLimited("Juda tez. Birozdan keyin qayta urinib ko'ring", retry_after=int(window - (now - arr[0])) + 1)
        arr.append(now)
        self._hits[key] = arr
        if len(self._hits) > 50_000:
            self._hits.clear()


limiter = SimpleRateLimiter()

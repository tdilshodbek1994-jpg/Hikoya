from __future__ import annotations

from sqlalchemy import select

from app.core import content_schema as cs
from app.models import Genre, User
from app.services import content as content_svc
from app.services.identity import get_or_create_user_by_tg, load_actor


def doc(*paras: str) -> dict:
    return cs.sanitize_doc({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": p}]} for p in paras]})


def long_doc(n: int = 30, words: int = 30) -> dict:
    return doc(*[" ".join(f"so'z{i}_{j}" for j in range(words)) for i in range(n)])


async def actor_for(db, tg_id: int, name: str = "User"):
    user = await get_or_create_user_by_tg(db, tg_id, name)
    await db.flush()
    return await load_actor(db, user)


async def genre_id(db, slug: str) -> int:
    return await db.scalar(select(Genre.id).where(Genre.slug == slug))


async def make_work(
    db,
    owner_tg: int = 1000,
    *,
    title: str = "Sinov asari",
    genre: str = "hayotiy",
    policy: str = "FREE",
    chapters: int = 1,
    completion: str = "completed",
    paras: int = 30,
    publish: bool = True,
):
    actor = await actor_for(db, owner_tg, "Egasi")
    w = await content_svc.create_work(
        db, actor, title=title, synopsis="Qisqa annotatsiya", primary_genre_id=await genre_id(db, genre), access_policy=policy, completion_state=completion
    )
    chs = []
    for i in range(chapters):
        chs.append(await content_svc.add_chapter(db, actor, w, title=f"{i + 1}-bob", doc=long_doc(paras)))
    if publish:
        await content_svc.publish_now(db, actor, w)
    await db.commit()
    return w, chs, actor


async def user_by_tg(db, tg: int) -> User:
    return await db.scalar(select(User).where(User.telegram_user_id == tg))

"""Management commands.

    python -m app.cli migrate            # alembic upgrade head
    python -m app.cli seed               # genres, tags, home layout, products (demo prices)
    python -m app.cli demo               # original demo content, marked «demo»
    python -m app.cli demo-remove        # delete demo content
    python -m app.cli grant <tg_id> <role>
"""

from __future__ import annotations

import asyncio
import subprocess
import sys

from app.db import sessionmaker


async def _seed() -> None:
    from app.services.seed import seed_reference

    async with sessionmaker()() as db:
        await seed_reference(db)
        await db.commit()
    print("reference data ok")


async def _owner_actor(db):
    from app.config import get_settings
    from app.services.identity import get_or_create_user_by_tg, load_actor

    owners = get_settings().owner_telegram_ids
    if not owners:
        raise SystemExit("HIKOYA_OWNER_TELEGRAM_IDS bo'sh")
    user = await get_or_create_user_by_tg(db, owners[0], "Egasi")
    await db.flush()
    return await load_actor(db, user)


async def _demo(remove: bool) -> None:
    from app.services.demo import remove_demo, seed_demo

    async with sessionmaker()() as db:
        if remove:
            res = await remove_demo(db)
        else:
            res = await seed_demo(db, await _owner_actor(db))
        await db.commit()
    print(res)


async def _grant(tg: str, role: str) -> None:
    from app.services.identity import find_user, grant_role

    async with sessionmaker()() as db:
        actor = await _owner_actor(db)
        target = await find_user(db, tg)
        if target is None:
            raise SystemExit("foydalanuvchi topilmadi (avval botni ochsin)")
        await grant_role(db, actor, target, role)
        await db.commit()
    print("ok")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "migrate":
        raise SystemExit(subprocess.call(["alembic", "upgrade", "head"]))
    if cmd == "seed":
        asyncio.run(_seed())
    elif cmd == "demo":
        asyncio.run(_demo(False))
    elif cmd == "demo-remove":
        asyncio.run(_demo(True))
    elif cmd == "grant" and len(sys.argv) == 4:
        asyncio.run(_grant(sys.argv[2], sys.argv[3]))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()

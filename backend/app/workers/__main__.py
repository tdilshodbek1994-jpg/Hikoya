"""Background worker + scheduler: ``python -m app.workers``.

Safe to run several copies: publish jobs are claimed atomically, outbox/deliveries use SKIP LOCKED.
"""

from __future__ import annotations

import asyncio
import logging
import time

from sqlalchemy import select

from app.core.timeutil import utcnow
from app.db import sessionmaker
from app.models import PublishJob, RankingSnapshot

log = logging.getLogger("hikoya.worker")


async def run_due_publish_jobs(limit: int = 20) -> int:
    from app.services.content import run_publish_job

    async with sessionmaker()() as db:
        ids = (await db.scalars(select(PublishJob.id).where(PublishJob.status == "pending", PublishJob.run_at <= utcnow()).order_by(PublishJob.run_at).limit(limit))).all()
    n = 0
    for jid in ids:
        async with sessionmaker()() as db:
            try:
                res = await run_publish_job(db, jid)
                await db.commit()
                n += res == "done"
            except Exception as e:
                await db.rollback()
                log.exception("publish job %s: %s", jid, e)
    if n:
        from app.services.catalog import invalidate_cache

        invalidate_cache()
    return n


async def process_outbox() -> int:
    from app.services.notify import process_outbox as po

    async with sessionmaker()() as db:
        n = await po(db)
        await db.commit()
    return n


async def deliver() -> dict:
    from app.services.notify import deliver_pending

    async with sessionmaker()() as db:
        stats = await deliver_pending(db)
        await db.commit()
    return stats


async def expire_orders() -> int:
    from app.services.billing import expire_stale_orders, mature_royalties

    async with sessionmaker()() as db:
        n = await expire_stale_orders(db)
        await mature_royalties(db)  # royalty entries leave "pending" after the refund hold period
        from app.services.growth import reward_referrals

        await reward_referrals(db)
        await db.commit()
    return n


async def snapshot_rankings() -> None:
    """Keep a history of rankings with formula version and computation time (spec 25 ranking_snapshots)."""
    from app.services.access import Entitlements
    from app.services.catalog import invalidate_cache, rankings

    invalidate_cache()
    async with sessionmaker()() as db:
        for metric, period in (("most_read", "today"), ("most_read", "week"), ("most_read", "month"), ("most_read", "all"), ("trend", "today")):
            r = await rankings(db, None, Entitlements(), metric, period, None, 50)
            from app.core.timeutil import period_start

            db.add(RankingSnapshot(metric=metric, period=period, period_start=period_start(period) if period != "all" else None, formula_version=r["formula_version"], items=[{"work_id": i["id"], "rank": i["rank"], "score": i["score"]} for i in r["items"]]))
        await db.commit()


async def tick() -> None:
    from app.bot.dispatcher import retry_failed_payment_updates

    await run_due_publish_jobs()
    await process_outbox()
    await deliver()
    await retry_failed_payment_updates()


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    last_slow = 0.0
    log.info("worker started")
    while True:
        started = time.monotonic()
        try:
            await tick()
            if started - last_slow > 600:
                await expire_orders()
                await snapshot_rankings()
                last_slow = started
        except Exception:
            log.exception("tick failed")
        await asyncio.sleep(max(0.5, 2 - (time.monotonic() - started)))


if __name__ == "__main__":
    asyncio.run(main())

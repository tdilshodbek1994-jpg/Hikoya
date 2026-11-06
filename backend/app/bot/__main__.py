"""Bot runner.

    python -m app.bot setup     # commands, menu button and webhook (if HIKOYA_WEBHOOK_SECRET is set)
    python -m app.bot polling   # local development without a public URL (deletes the webhook)
"""

from __future__ import annotations

import asyncio
import logging
import sys

from app.bot.dispatcher import ALLOWED_UPDATES, process_update, setup_bot
from app.integrations.telegram import get_telegram

log = logging.getLogger("hikoya.bot")


async def polling() -> None:
    tg = get_telegram()
    if not tg.enabled:
        raise SystemExit("HIKOYA_TELEGRAM_ENABLED=true va HIKOYA_BOT_TOKEN kerak")
    await tg.call("deleteWebhook", drop_pending_updates=False)
    offset = 0
    log.info("polling started")
    while True:
        try:
            updates = await tg.call("getUpdates", offset=offset, timeout=50, allowed_updates=ALLOWED_UPDATES)
        except Exception as e:
            log.warning("getUpdates: %s", e)
            await asyncio.sleep(3)
            continue
        for u in updates or []:
            offset = max(offset, int(u["update_id"]) + 1)
            await process_update(u)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "polling"
    if cmd == "setup":
        asyncio.run(setup_bot())
    else:
        asyncio.run(polling())


if __name__ == "__main__":
    main()

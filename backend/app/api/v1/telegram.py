from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Header, Request

from app.config import get_settings
from app.core.errors import NotFound, Unauthorized

router = APIRouter(tags=["telegram"])


@router.post("/telegram/webhook", include_in_schema=False)
async def webhook(request: Request, x_telegram_bot_api_secret_token: Annotated[str | None, Header()] = None):
    s = get_settings()
    if not s.webhook_secret:
        raise NotFound()
    if not x_telegram_bot_api_secret_token or not hmac.compare_digest(x_telegram_bot_api_secret_token, s.webhook_secret):
        raise Unauthorized()
    update = await request.json()
    from app.bot.dispatcher import process_update

    res = await process_update(update)
    return {"ok": True, "status": res["status"]}

"""Bot API route: relay base URL, long-poll timeout, IPv4 transport option."""

import httpx

from app.config import get_settings
from app.integrations.telegram import TelegramAPI, http_client


async def test_relay_base_and_long_poll_timeout():
    s = get_settings()
    old = (s.telegram_api_base, s.telegram_enabled)
    s.telegram_api_base, s.telegram_enabled = "https://relay.example.workers.dev", True
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((str(req.url), req.extensions["timeout"]["read"]))
        return httpx.Response(200, json={"ok": True, "result": []})

    try:
        api = TelegramAPI()
        api._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=httpx.Timeout(15.0, connect=10.0))
        await api.call("getUpdates", offset=0, timeout=50)
        await api.call("sendMessage", chat_id=1, text="x")
    finally:
        s.telegram_api_base, s.telegram_enabled = old
    assert seen[0][0].startswith("https://relay.example.workers.dev/bot") and seen[0][0].endswith("/getUpdates")
    assert seen[0][1] == 65.0  # 50 s server wait + margin: polling no longer times out every 15 s
    assert seen[1][1] == 15.0


async def test_force_ipv4_transport():
    s = get_settings()
    old = s.telegram_force_ipv4
    s.telegram_force_ipv4 = True
    try:
        async with http_client() as c:
            pool = c._transport._pool
            assert pool._local_address == "0.0.0.0"
    finally:
        s.telegram_force_ipv4 = old

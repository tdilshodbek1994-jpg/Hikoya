"""Minimal Telegram Bot API client used by services and workers.

When ``HIKOYA_TELEGRAM_ENABLED`` is false (development/tests) no request leaves the server:
calls are recorded in ``telegram_calls`` and a deterministic fake response is returned.
"""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx

from app.config import get_settings


class TelegramError(Exception):
    def __init__(self, code: int, description: str, retry_after: int | None = None):
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description
        self.retry_after = retry_after

    @property
    def blocked(self) -> bool:
        d = self.description.lower()
        return self.code == 403 and ("blocked" in d or "deactivated" in d or "can't initiate" in d)


class TelegramUncertain(Exception):
    """Network error / timeout: the request may or may not have been executed."""


FakeHook = Callable[[str, dict], Any]


class TelegramAPI:
    def __init__(self):
        s = get_settings()
        self.enabled = s.telegram_enabled
        self.base = f"{s.telegram_api_base}/bot{s.bot_token}"
        self.fake_hook: FakeHook | None = None
        self.calls: list[tuple[str, dict]] = []
        self._client: httpx.AsyncClient | None = None

    async def call(self, method: str, **params: Any) -> Any:
        params = {k: v for k, v in params.items() if v is not None}
        self.calls.append((method, params))
        if not self.enabled:
            if self.fake_hook:
                res = self.fake_hook(method, params)
                if isinstance(res, Exception):
                    raise res
                if res is not None:
                    return res
            return _fake(method, params)
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))
        try:
            r = await self._client.post(f"{self.base}/{method}", json=params)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            raise TelegramUncertain(str(e)) from e
        try:
            body = r.json()
        except json.JSONDecodeError as e:
            raise TelegramUncertain(f"bad response {r.status_code}") from e
        if body.get("ok"):
            return body.get("result")
        params_ = body.get("parameters") or {}
        raise TelegramError(body.get("error_code", r.status_code), body.get("description", ""), params_.get("retry_after"))


def _fake(method: str, params: dict) -> Any:
    if method == "createInvoiceLink":
        return f"https://t.me/$fake_invoice_{params.get('payload', '')}"
    if method in ("sendMessage", "sendPhoto", "sendDocument"):
        return {"message_id": 1, "chat": {"id": params.get("chat_id")}}
    if method == "getFile":
        return {"file_id": params.get("file_id"), "file_path": "fake/path"}
    return True


_api: TelegramAPI | None = None


def get_telegram() -> TelegramAPI:
    global _api
    if _api is None:
        _api = TelegramAPI()
    return _api


def reset_telegram() -> None:
    global _api
    _api = None

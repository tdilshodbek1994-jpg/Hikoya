"""Reply objects and keyboard helpers for the bot. Pure data — sending happens in the dispatcher."""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import quote

from app.config import get_settings


@dataclass
class Reply:
    text: str
    buttons: list[list[dict]] = field(default_factory=list)
    photo: str | None = None

    def markup(self) -> dict | None:
        return {"inline_keyboard": self.buttons} if self.buttons else None


def cb(text: str, data: str) -> dict:
    assert len(data.encode()) <= 64, data
    return {"text": text, "callback_data": data}


def webapp(text: str, param: str = "") -> dict:
    """Mini App button for private chats. The param is a routing hint only; access is checked again."""
    url = get_settings().webapp_url.rstrip("/")
    if param:
        url += f"/?p={quote(param)}"
    return {"text": text, "web_app": {"url": url}}


def link(text: str, url: str) -> dict:
    return {"text": text, "url": url}


def deep_link(param: str = "") -> str:
    s = get_settings()
    base = f"https://t.me/{s.bot_username}/{s.miniapp_short_name}"
    return f"{base}?startapp={param}" if param else base


def esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


BACK = "« Orqaga"
SAVE = "💾 Qoralamaga saqlash"
CANCEL = "✖️ Bekor qilish"

"""Telegram Mini App initData validation and server-side session/sign helpers.

Validation follows https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token); hash = HMAC_SHA256(secret_key, data_check_string).
initDataUnsafe is never trusted; only the raw string is validated here.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

from app.core.errors import Unauthorized


@dataclass
class TelegramIdentity:
    telegram_user_id: int
    first_name: str
    last_name: str
    language_code: str
    is_premium_telegram: bool  # informational only, NEVER an entitlement (T-39)
    start_param: str
    auth_date: int


def validate_init_data(init_data: str, bot_token: str, max_age_seconds: int, now: float | None = None) -> TelegramIdentity:
    if not init_data or not bot_token:
        raise Unauthorized("initData yo'q", code="auth_missing")
    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    except ValueError as e:
        raise Unauthorized("initData formati noto'g'ri", code="auth_invalid") from e
    data = dict(pairs)
    received_hash = data.pop("hash", "")
    if not received_hash or len(pairs) != len(data) + 1:
        raise Unauthorized("initData imzosi yo'q", code="auth_invalid")
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        raise Unauthorized("initData imzosi noto'g'ri", code="auth_invalid")
    try:
        auth_date = int(data.get("auth_date", "0"))
    except ValueError as e:
        raise Unauthorized("auth_date noto'g'ri", code="auth_invalid") from e
    now = time.time() if now is None else now
    if auth_date <= 0 or now - auth_date > max_age_seconds or auth_date - now > 60:
        raise Unauthorized("Kirish muddati o'tgan, ilovani qayta oching", code="auth_expired")
    try:
        user = json.loads(data.get("user", "{}"))
        uid = int(user["id"])
    except (ValueError, KeyError, TypeError) as e:
        raise Unauthorized("Foydalanuvchi ma'lumoti yo'q", code="auth_invalid") from e
    return TelegramIdentity(
        telegram_user_id=uid,
        first_name=str(user.get("first_name", ""))[:64],
        last_name=str(user.get("last_name", ""))[:64],
        language_code=str(user.get("language_code", ""))[:8],
        is_premium_telegram=bool(user.get("is_premium", False)),
        start_param=str(data.get("start_param", ""))[:64],
        auth_date=auth_date,
    )


def build_init_data(bot_token: str, user: dict, auth_date: int | None = None, **extra: str) -> str:
    """Build a correctly signed initData string (tests and local dev tooling)."""
    from urllib.parse import urlencode

    fields = {"auth_date": str(auth_date or int(time.time())), "user": json.dumps(user, separators=(",", ":")), **extra}
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_payload(payload: dict, key: str) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64(hmac.new(key.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_payload(token: str, key: str, now: float | None = None) -> dict:
    try:
        body, sig = token.split(".", 1)
    except ValueError as e:
        raise Unauthorized("Havola noto'g'ri", code="link_invalid") from e
    expected = _b64(hmac.new(key.encode(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, sig):
        raise Unauthorized("Havola noto'g'ri", code="link_invalid")
    payload = json.loads(_unb64(body))
    if payload.get("exp", 0) < (time.time() if now is None else now):
        raise Unauthorized("Havola muddati o'tgan", code="link_expired")
    return payload

"""`python -m app.bot check`: why can't the server talk to Telegram? Prints a verdict and the fix.

Checks DNS, raw TCP over IPv4 and IPv6, HTTPS to api.telegram.org, the configured route
(HIKOYA_TELEGRAM_API_BASE / _PROXY / _FORCE_IPV4) with getMe, and a Cloudflare host as a
reference (to tell "Telegram blocked" from "no internet at all"). Never prints the token.
"""

from __future__ import annotations

import asyncio
import socket
import time

import httpx

from app.config import get_settings
from app.integrations.telegram import http_client

HOST = "api.telegram.org"


def _p(ok: bool | None, label: str, info: str = "") -> None:
    mark = "OK  " if ok else ("XATO" if ok is False else "--  ")
    print(f"[{mark}] {label}{(': ' + info) if info else ''}")


async def _tcp(family: int, host: str, port: int = 443, timeout: float = 6) -> tuple[bool | None, str]:
    try:
        infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
    except socket.gaierror as e:
        return None, f"manzil yo'q ({e.strerror})"
    addr = infos[0][4]
    t = time.monotonic()
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(addr[0], port, family=family), timeout)
        w.close()
        return True, f"{addr[0]} {int((time.monotonic() - t) * 1000)} ms"
    except (OSError, asyncio.TimeoutError) as e:
        return False, f"{addr[0]} {type(e).__name__}"


async def _https(url: str, **kw) -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=8), **kw) as c:
            r = await c.get(url)
        return True, f"HTTP {r.status_code}"
    except Exception as e:  # noqa: BLE001 — diagnostics: report any failure
        return False, type(e).__name__


async def check() -> None:
    s = get_settings()
    print("Telegram ulanishi tekshiruvi\n")
    try:
        addrs = sorted({i[4][0] for i in socket.getaddrinfo(HOST, 443, proto=socket.IPPROTO_TCP)})
        _p(True, "DNS api.telegram.org", ", ".join(addrs))
    except socket.gaierror as e:
        _p(False, "DNS api.telegram.org", str(e))
    v4 = await _tcp(socket.AF_INET, HOST)
    _p(v4[0], "TCP IPv4 :443", v4[1])
    v6 = await _tcp(socket.AF_INET6, HOST)
    _p(v6[0], "TCP IPv6 :443", v6[1])
    direct = await _https(f"https://{HOST}/")
    _p(direct[0], "HTTPS api.telegram.org (to'g'ridan-to'g'ri)", direct[1])
    ref = await _https("https://www.cloudflare.com/cdn-cgi/trace")
    _p(ref[0], "HTTPS cloudflare.com (internet bormi)", ref[1])

    route = []
    if s.telegram_api_base != "https://api.telegram.org":
        route.append(f"relay {s.telegram_api_base.split('//')[-1].split('/')[0]}")
    if s.telegram_proxy:
        route.append("proxy " + s.telegram_proxy.split("@")[-1])
    if s.telegram_force_ipv4:
        route.append("IPv4")
    print(f"\nSozlangan yo'l: {', '.join(route) or 'to`g`ridan-to`g`ri'}")
    me_ok = False
    if s.bot_token:
        try:
            async with http_client() as c:
                r = await c.get(f"{s.telegram_api_base}/bot{s.bot_token}/getMe")
            body = r.json()
            me_ok = bool(body.get("ok"))
            _p(me_ok, "getMe", "@" + body["result"]["username"] if me_ok else str(body.get("description", r.status_code)))
        except Exception as e:  # noqa: BLE001
            _p(False, "getMe", type(e).__name__)
    else:
        _p(None, "getMe", "HIKOYA_BOT_TOKEN bo'sh")

    print("\nXulosa:")
    if me_ok:
        print("  Bot API ishlayapti. Endi: make bot-setup")
    elif v4[0] and not v6[0] and not s.telegram_force_ipv4:
        print("  IPv4 ishlaydi, IPv6 yo'q. .env ga HIKOYA_TELEGRAM_FORCE_IPV4=true yozing, make up, so'ng qayta tekshiring.")
    elif not ref[0]:
        print("  Serverdan umuman tashqi internet yo'q (firewall yoki DNS). Hosting sozlamalarini tekshiring.")
    else:
        print("  api.telegram.org bu serverdan yopiq. Variantlar (docs/TELEGRAM_ACCESS.md):")
        print("   1) Cloudflare Worker relay (bepul): HIKOYA_TELEGRAM_API_BASE=https://<nom>.workers.dev")
        print("   2) SOCKS5/HTTP proksi: HIKOYA_TELEGRAM_PROXY=socks5://user:pass@host:1080")
        print("   3) Timeweb'ning boshqa lokatsiyasi (Amsterdam/Frankfurt/Almaty): deploy/migrate-*.sh")

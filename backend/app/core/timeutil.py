from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.config import get_settings


def tz() -> ZoneInfo:
    return ZoneInfo(get_settings().timezone)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def local_date(dt: datetime | None = None) -> date:
    return (dt or utcnow()).astimezone(tz()).date()


def period_start(period: str, now: datetime | None = None) -> datetime | None:
    """Start of the calendar period in Asia/Tashkent, returned in UTC (spec 13.4)."""
    now_local = (now or utcnow()).astimezone(tz())
    d = now_local.date()
    if period == "today":
        start = d
    elif period == "week":
        start = d - timedelta(days=d.weekday())  # Monday
    elif period == "month":
        start = d.replace(day=1)
    elif period == "all":
        return None
    else:
        raise ValueError(period)
    return datetime.combine(start, time(0), tzinfo=tz()).astimezone(timezone.utc)


def period_start_date(period: str, now: datetime | None = None) -> date | None:
    ps = period_start(period, now)
    return ps.astimezone(tz()).date() if ps else None


def in_quiet_hours(start: str, end: str, tz_name: str, now: datetime | None = None) -> bool:
    local = (now or utcnow()).astimezone(ZoneInfo(tz_name)).time()
    s = time.fromisoformat(start)
    e = time.fromisoformat(end)
    if s == e:
        return False
    return (s <= local or local < e) if s > e else (s <= local < e)


def next_quiet_end(end: str, tz_name: str, now: datetime | None = None) -> datetime:
    z = ZoneInfo(tz_name)
    local = (now or utcnow()).astimezone(z)
    e = time.fromisoformat(end)
    candidate = datetime.combine(local.date(), e, tzinfo=z)
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)

from __future__ import annotations

import os
import tempfile

os.environ.setdefault("HIKOYA_ENV", "test")
os.environ.setdefault("HIKOYA_DATABASE_URL", "postgresql+asyncpg://hikoya:hikoya@localhost:5432/hikoya_test")
os.environ["HIKOYA_BOT_TOKEN"] = "123456:TEST-TOKEN"
os.environ["HIKOYA_DEV_AUTH_ENABLED"] = "false"
os.environ["HIKOYA_OWNER_TELEGRAM_IDS"] = "[1000]"
os.environ["HIKOYA_TEST_TELEGRAM_IDS"] = "[9999]"
os.environ["HIKOYA_STORAGE_LOCAL_DIR"] = tempfile.mkdtemp(prefix="hikoya-test-storage-")
os.environ["HIKOYA_BILLING_ENABLED"] = "true"
os.environ["HIKOYA_TELEGRAM_ENABLED"] = "false"

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.config import get_settings
from app.core.security import build_init_data
from app.db import Base, get_engine, reset_engine, sessionmaker


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def _schema():
    import app.models  # noqa: F401

    reset_engine()
    eng = get_engine()
    async with eng.begin() as c:
        await c.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        await c.run_sync(Base.metadata.drop_all)
        await c.run_sync(Base.metadata.create_all)
    yield
    await eng.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def db(_schema):
    tables = ", ".join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
    async with get_engine().begin() as c:
        await c.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    from app.services.catalog import invalidate_cache
    from app.services.seed import seed_reference

    invalidate_cache()
    from app.api.deps import limiter
    from app.integrations.telegram import get_telegram

    limiter._hits.clear()
    get_telegram().fake_hook = None
    get_telegram().calls.clear()
    async with sessionmaker()() as s:
        await seed_reference(s)
        await s.commit()
    async with sessionmaker()() as s:
        yield s


@pytest_asyncio.fixture(loop_scope="session")
async def client(db):
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def init_data_for(tg_id: int, name: str = "Test", **extra) -> str:
    return build_init_data(get_settings().bot_token, {"id": tg_id, "first_name": name, "language_code": "uz"}, **extra)


async def login(client: AsyncClient, tg_id: int, name: str = "Test") -> dict:
    r = await client.post("/api/v1/auth/telegram", json={"init_data": init_data_for(tg_id, name)})
    assert r.status_code == 200, r.text
    data = r.json()
    return {"Authorization": f"Bearer {data['token']}", "_me": data["me"]}


def H(auth: dict) -> dict:
    return {k: v for k, v in auth.items() if not k.startswith("_")}


@pytest.fixture
def owner_tg() -> int:
    return 1000

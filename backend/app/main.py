from __future__ import annotations

import logging
import os
import secrets

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.core.errors import AppError, app_error_handler, validation_error_handler

log = logging.getLogger("hikoya")


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="HIKOYA PRO API",
        version="1.0.0",
        description="Telegram Mini App + boshqaruv boti uchun API. Barcha endpointlar /api/v1 ostida.",
        docs_url="/api/docs" if not s.is_production else None,
        openapi_url="/api/openapi.json",
    )
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    )

    @app.middleware("http")
    async def request_id_mw(request: Request, call_next):
        rid = request.headers.get("x-request-id", "")[:64] or secrets.token_hex(8)
        request.state.request_id = rid
        response = await call_next(request)
        response.headers["X-Request-Id"] = rid
        return response

    from app.api.v1 import router as v1

    app.include_router(v1, prefix="/api/v1")

    @app.get("/api/health")
    async def health():
        from sqlalchemy import text

        from app.db import sessionmaker

        async with sessionmaker()() as db:
            await db.execute(text("select 1"))
        return {"ok": True}

    if s.storage_backend == "local":
        public_dir = os.path.join(os.path.abspath(s.storage_local_dir), "public")
        os.makedirs(public_dir, exist_ok=True)
        app.mount("/media", StaticFiles(directory=public_dir), name="media")
    return app


app = create_app()

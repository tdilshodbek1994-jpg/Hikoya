from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class AppError(Exception):
    status = 400
    code = "bad_request"

    def __init__(self, message: str = "", *, code: str | None = None, status: int | None = None, **extra: Any):
        super().__init__(message or self.code)
        self.message = message or self.code
        if code:
            self.code = code
        if status:
            self.status = status
        self.extra = extra


class Unauthorized(AppError):
    status, code = 401, "unauthorized"


class Forbidden(AppError):
    status, code = 403, "forbidden"


class NotFound(AppError):
    status, code = 404, "not_found"


class Conflict(AppError):
    status, code = 409, "conflict"


class Invalid(AppError):
    status, code = 422, "invalid_input"


class RateLimited(AppError):
    status, code = 429, "rate_limited"


class AccessRequired(AppError):
    """Paywall: the object exists, the user lacks an entitlement. Carries offer info."""

    status, code = 403, "access_required"


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    body = {"error_code": exc.code, "message": exc.message, "request_id": getattr(request.state, "request_id", "")}
    body.update(exc.extra)
    return JSONResponse(body, status_code=exc.status)


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg", "")} for e in exc.errors()]
    return JSONResponse(
        {
            "error_code": "invalid_input",
            "message": "Kiritilgan ma'lumot noto'g'ri",
            "errors": errors,
            "request_id": getattr(request.state, "request_id", ""),
        },
        status_code=422,
    )

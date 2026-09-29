"""Application error types and a consistent error envelope.

All handled errors are returned as:

    {"error": {"code": "SOME_CODE", "message": "Human readable message."}}

Stack traces are never exposed to clients.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    """Base class for expected, client-safe errors."""

    status_code = 400
    code = "BAD_REQUEST"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code


class DocumentNotFound(AppError):
    status_code = 404
    code = "DOCUMENT_NOT_FOUND"


class ConversationNotFound(AppError):
    status_code = 404
    code = "CONVERSATION_NOT_FOUND"


class ValidationError(AppError):
    status_code = 422
    code = "VALIDATION_ERROR"


class RateLimited(AppError):
    status_code = 429
    code = "RATE_LIMITED"


class UpstreamUnavailable(AppError):
    status_code = 503
    code = "UPSTREAM_UNAVAILABLE"


class NeedsReindex(AppError):
    """The document is known but its vectors are missing (e.g. after a restart
    with an in-memory store). The client should re-index and retry."""

    status_code = 409
    code = "NEEDS_REINDEX"


def error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message),
    )


async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Never leak internals to the client; details go to logs.
    from .logging import get_logger

    get_logger("shawwn.error").exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content=error_body("INTERNAL_ERROR", "An internal error occurred."),
    )

"""Simple in-memory sliding-window rate limiter.

Protects the expensive endpoints (/chat, /documents). For production, swap the
in-memory store for Redis (the interface is small and isolated here). Disabled
via RATE_LIMIT_ENABLED=false.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Deque, Dict, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from ..core.config import get_settings
from ..core.errors import error_body


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app):
        super().__init__(app)
        self._hits: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)

    def _limit_for(self, path: str, settings) -> int:
        if path.endswith("/chat"):
            return settings.rate_limit_chat
        if path.endswith("/documents"):
            return settings.rate_limit_documents
        return 0  # unlimited

    async def dispatch(self, request: Request, call_next):
        settings = get_settings()
        if not settings.rate_limit_enabled or request.method not in ("POST",):
            return await call_next(request)

        limit = self._limit_for(request.url.path, settings)
        if limit <= 0:
            return await call_next(request)

        client = request.client.host if request.client else "unknown"
        key = (client, request.url.path)
        now = time.time()
        window = settings.rate_limit_window_seconds
        bucket = self._hits[key]

        while bucket and now - bucket[0] > window:
            bucket.popleft()

        if len(bucket) >= limit:
            return JSONResponse(
                status_code=429,
                content=error_body(
                    "RATE_LIMITED", "Too many requests. Please slow down."
                ),
            )
        bucket.append(now)
        return await call_next(request)

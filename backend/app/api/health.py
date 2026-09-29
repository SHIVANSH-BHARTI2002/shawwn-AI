"""Health endpoint. Reports version, active mode and per-service status."""

from __future__ import annotations

from fastapi import APIRouter

from .. import __version__
from ..core.config import get_settings
from ..models.schemas import HealthResponse
from ..services.runtime import get_runtime

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    settings = get_settings()
    runtime = get_runtime()
    return HealthResponse(
        status="ok",
        version=__version__,
        mode="light" if runtime.light_mode else "full",
        services=runtime.service_status(),
    )

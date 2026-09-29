"""FastAPI application entry point for the shawwn RAG backend."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api import chat, conversations, documents, health, search
from .core.config import get_settings
from .core.errors import AppError, app_error_handler, unhandled_error_handler
from .core.logging import configure_logging, get_logger
from .middleware.rate_limit import RateLimitMiddleware
from .models.database import init_db

logger = get_logger("shawwn.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    settings = get_settings()
    logger.info("Starting shawwn backend v%s (%s)", __version__, settings.app_env)
    await init_db()
    yield
    logger.info("Shutting down shawwn backend")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="shawwn RAG API",
        version=__version__,
        description="Webpage RAG assistant backend for the PageContext extension.",
        docs_url="/docs" if settings.swagger_enabled else None,
        redoc_url="/redoc" if settings.swagger_enabled else None,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_origin_regex=r"chrome-extension://.*",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(RateLimitMiddleware)

    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    app.include_router(health.router)
    app.include_router(documents.router, prefix="/api/v1")
    app.include_router(chat.router, prefix="/api/v1")
    app.include_router(conversations.router, prefix="/api/v1")
    app.include_router(search.router, prefix="/api/v1")

    return app


app = create_app()

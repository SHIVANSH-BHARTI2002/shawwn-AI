"""Structured logging setup.

Provides a small helper for timing pipeline stages. We deliberately avoid
logging secrets (API keys, tokens) and full webpage content; only lengths and
counts are logged for page data.
"""

from __future__ import annotations

import logging
import sys
import time
from contextlib import contextmanager

from .config import get_settings

_CONFIGURED = False


def configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    settings = get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(name)


@contextmanager
def timed(logger: logging.Logger, stage: str):
    """Context manager that logs how long a pipeline stage took (ms)."""
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.info("%s completed in %.1f ms", stage, elapsed_ms)

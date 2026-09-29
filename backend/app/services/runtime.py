"""Runtime service container.

Holds lazily-constructed singletons for the embedding service, vector store,
reranker and LLM provider. It also determines whether we run in *light* mode
(deterministic fallbacks) or *full* mode (real models + services).

Light mode is chosen when:
  * SHAWWN_LIGHT_MODE=true, or
  * the heavy ML dependencies / external services are not importable/reachable.

This lets the same code run in CI/tests (light) and production (full).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Dict, Optional

from ..core.config import get_settings
from ..core.logging import get_logger

logger = get_logger("shawwn.runtime")


class Runtime:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.light_mode = self._detect_light_mode()

        self._embedder = None
        self._vector_store = None
        self._reranker = None
        self._llm = None

        logger.info("Runtime initialized in %s mode", "light" if self.light_mode else "full")

    # ---- mode detection -------------------------------------------------- #
    def _detect_light_mode(self) -> bool:
        if self.settings.light_mode:
            return True
        # If the heavy ML stack isn't installed, fall back to light mode.
        try:
            import sentence_transformers  # noqa: F401
            import FlagEmbedding  # noqa: F401
        except Exception:
            logger.warning(
                "ML dependencies not available; using light-mode fallbacks."
            )
            return True
        return False

    # ---- component accessors -------------------------------------------- #
    def embedder(self):
        if self._embedder is None:
            from ..embeddings.bge import build_embedder

            self._embedder = build_embedder(self.settings, self.light_mode)
        return self._embedder

    def vector_store(self):
        if self._vector_store is None:
            from ..retrieval.vector import build_vector_store

            self._vector_store = build_vector_store(
                self.settings, self.embedder().dim, self.light_mode
            )
        return self._vector_store

    def reranker(self):
        if self._reranker is None:
            from ..retrieval.reranker import build_reranker

            self._reranker = build_reranker(self.settings, self.light_mode)
        return self._reranker

    def llm(self):
        if self._llm is None:
            from ..llm import build_llm

            self._llm = build_llm(self.settings, self.light_mode)
        return self._llm

    # ---- status ---------------------------------------------------------- #
    def service_status(self) -> Dict[str, str]:
        return {
            "embedder": type(self.embedder()).__name__,
            "vector_store": type(self.vector_store()).__name__,
            "reranker": type(self.reranker()).__name__,
            "llm": type(self.llm()).__name__,
        }


_runtime: Optional[Runtime] = None


@lru_cache
def get_runtime() -> Runtime:
    global _runtime
    if _runtime is None:
        _runtime = Runtime()
    return _runtime

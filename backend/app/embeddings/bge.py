"""Embedding service abstraction.

`EmbeddingService` defines the interface. Two implementations:

* `BGEEmbeddingService`  - real BGE-M3 via sentence-transformers (full mode).
* `HashingEmbeddingService` - deterministic, dependency-free embeddings for
  light mode / tests. It is a hashed bag-of-words projection that produces
  stable, L2-normalized vectors with meaningful cosine similarity for lexical
  overlap. Not as good as BGE-M3, but fully deterministic and offline.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import List

_TOKEN = re.compile(r"[a-z0-9]+")


class EmbeddingService:
    dim: int

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        raise NotImplementedError

    def embed_query(self, query: str) -> List[float]:
        raise NotImplementedError


def _tokenize(text: str) -> List[str]:
    return _TOKEN.findall(text.lower())


class HashingEmbeddingService(EmbeddingService):
    """Deterministic hashed embeddings (offline, no downloads)."""

    def __init__(self, dim: int = 256):
        self.dim = dim

    def _embed(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        tokens = _tokenize(text)
        if not tokens:
            vec[0] = 1.0
            return vec
        for tok in tokens:
            h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
            idx = h % self.dim
            sign = 1.0 if (h >> 8) & 1 else -1.0
            vec[idx] += sign
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, query: str) -> List[float]:
        return self._embed(query)


class BGEEmbeddingService(EmbeddingService):
    """Real BGE-M3 embeddings via sentence-transformers (full mode)."""

    def __init__(self, model_name: str, dim: int, batch_size: int = 32):
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_name)
        self.dim = dim
        self.batch_size = batch_size

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        vectors = self._model.encode(
            texts,
            batch_size=self.batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return [v.tolist() for v in vectors]

    def embed_query(self, query: str) -> List[float]:
        vec = self._model.encode(
            [query], normalize_embeddings=True, show_progress_bar=False
        )[0]
        return vec.tolist()


def build_embedder(settings, light_mode: bool) -> EmbeddingService:
    if light_mode:
        return HashingEmbeddingService(dim=256)
    try:
        return BGEEmbeddingService(settings.embedding_model, settings.embedding_dim)
    except Exception:  # pragma: no cover - depends on optional heavy deps
        from ..core.logging import get_logger

        get_logger("shawwn.embeddings").warning(
            "Falling back to hashing embeddings (BGE unavailable)."
        )
        return HashingEmbeddingService(dim=256)

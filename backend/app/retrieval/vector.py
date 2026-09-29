"""Vector store abstraction with a Qdrant implementation and an in-memory
fallback used in light mode / tests.

Both implementations enforce **document isolation**: every search is filtered
by `document_id` so questions about the current page never retrieve chunks from
other pages.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class VectorHit:
    chunk_id: str
    score: float
    payload: Dict


class VectorStore:
    dim: int

    def ensure_collection(self) -> None:
        raise NotImplementedError

    def upsert(self, vectors: List[List[float]], payloads: List[Dict]) -> None:
        raise NotImplementedError

    def search(
        self, vector: List[float], document_id: str, top_k: int
    ) -> List[VectorHit]:
        raise NotImplementedError

    def delete_document(self, document_id: str) -> None:
        raise NotImplementedError

    def get_document_chunks(self, document_id: str) -> List[Dict]:
        """Return all chunk payloads for a document (used to build BM25)."""
        raise NotImplementedError


def _cosine(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


class InMemoryVectorStore(VectorStore):
    """Simple, deterministic in-memory store (no external service)."""

    def __init__(self, dim: int):
        self.dim = dim
        # chunk_id -> (vector, payload)
        self._data: Dict[str, tuple[List[float], Dict]] = {}

    def ensure_collection(self) -> None:
        return None

    def upsert(self, vectors: List[List[float]], payloads: List[Dict]) -> None:
        for vec, payload in zip(vectors, payloads):
            self._data[payload["chunk_id"]] = (vec, payload)

    def search(
        self, vector: List[float], document_id: str, top_k: int
    ) -> List[VectorHit]:
        scored = []
        for chunk_id, (vec, payload) in self._data.items():
            if payload.get("document_id") != document_id:
                continue
            scored.append(VectorHit(chunk_id, _cosine(vector, vec), payload))
        scored.sort(key=lambda h: h.score, reverse=True)
        return scored[:top_k]

    def delete_document(self, document_id: str) -> None:
        to_delete = [
            cid for cid, (_, p) in self._data.items() if p.get("document_id") == document_id
        ]
        for cid in to_delete:
            del self._data[cid]

    def get_document_chunks(self, document_id: str) -> List[Dict]:
        return [
            p for _, (_, p) in self._data.items() if p.get("document_id") == document_id
        ]


class QdrantVectorStore(VectorStore):
    """Qdrant-backed vector store (full mode)."""

    def __init__(self, url: str, api_key: str, collection: str, dim: int):
        from qdrant_client import QdrantClient

        self._client = QdrantClient(url=url, api_key=api_key or None)
        self.collection = collection
        self.dim = dim
        self.ensure_collection()

    def ensure_collection(self) -> None:
        from qdrant_client.models import Distance, VectorParams

        existing = {c.name for c in self._client.get_collections().collections}
        if self.collection not in existing:
            self._client.create_collection(
                collection_name=self.collection,
                vectors_config=VectorParams(size=self.dim, distance=Distance.COSINE),
            )

    def _point_id(self, chunk_id: str) -> int:
        import hashlib

        return int(hashlib.sha256(chunk_id.encode()).hexdigest()[:15], 16)

    def upsert(self, vectors: List[List[float]], payloads: List[Dict]) -> None:
        from qdrant_client.models import PointStruct

        points = [
            PointStruct(id=self._point_id(p["chunk_id"]), vector=v, payload=p)
            for v, p in zip(vectors, payloads)
        ]
        if points:
            self._client.upsert(collection_name=self.collection, points=points)

    def _doc_filter(self, document_id: str):
        from qdrant_client.models import FieldCondition, Filter, MatchValue

        return Filter(
            must=[
                FieldCondition(key="document_id", match=MatchValue(value=document_id))
            ]
        )

    def search(
        self, vector: List[float], document_id: str, top_k: int
    ) -> List[VectorHit]:
        res = self._client.search(
            collection_name=self.collection,
            query_vector=vector,
            query_filter=self._doc_filter(document_id),
            limit=top_k,
            with_payload=True,
        )
        return [
            VectorHit(r.payload["chunk_id"], float(r.score), r.payload) for r in res
        ]

    def delete_document(self, document_id: str) -> None:
        self._client.delete(
            collection_name=self.collection,
            points_selector=self._doc_filter(document_id),
        )

    def get_document_chunks(self, document_id: str) -> List[Dict]:
        payloads: List[Dict] = []
        offset = None
        while True:
            points, offset = self._client.scroll(
                collection_name=self.collection,
                scroll_filter=self._doc_filter(document_id),
                limit=256,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            payloads.extend(p.payload for p in points)
            if offset is None:
                break
        return payloads


def build_vector_store(settings, dim: int, light_mode: bool) -> VectorStore:
    if light_mode:
        return InMemoryVectorStore(dim=dim)
    try:
        return QdrantVectorStore(
            settings.qdrant_url,
            settings.qdrant_api_key,
            settings.qdrant_collection,
            dim,
        )
    except Exception:  # pragma: no cover - depends on running Qdrant
        from ..core.logging import get_logger

        get_logger("shawwn.vector").warning(
            "Qdrant unavailable; using in-memory vector store."
        )
        return InMemoryVectorStore(dim=dim)

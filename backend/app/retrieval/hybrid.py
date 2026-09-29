"""Hybrid retrieval: merge dense (vector) and sparse (BM25) candidate sets.

Scores from each retriever are min-max normalized to [0, 1] within their own
result set, then combined with configurable weights. Duplicates (same chunk_id)
are merged, keeping the combined score.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from .bm25 import BM25Hit, BM25Index
from .vector import VectorHit, VectorStore


@dataclass
class Candidate:
    chunk_id: str
    payload: Dict
    dense_score: float = 0.0
    bm25_score: float = 0.0
    combined_score: float = 0.0


@dataclass
class HybridResult:
    candidates: List[Candidate] = field(default_factory=list)
    dense_count: int = 0
    bm25_count: int = 0


def _minmax(values: List[float]) -> List[float]:
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-12:
        return [1.0 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


class HybridRetriever:
    def __init__(
        self,
        vector_store: VectorStore,
        embedder,
        *,
        dense_weight: float = 0.7,
        bm25_weight: float = 0.3,
    ):
        self.vector_store = vector_store
        self.embedder = embedder
        self.dense_weight = dense_weight
        self.bm25_weight = bm25_weight

    def retrieve(
        self, query: str, document_id: str, *, top_k_dense: int, top_k_bm25: int
    ) -> HybridResult:
        # Dense
        qvec = self.embedder.embed_query(query)
        dense_hits: List[VectorHit] = self.vector_store.search(
            qvec, document_id, top_k_dense
        )

        # Sparse (BM25) over this document's chunks only.
        payloads = self.vector_store.get_document_chunks(document_id)
        bm25_hits: List[BM25Hit] = BM25Index(payloads).search(query, top_k_bm25)

        dense_norm = _minmax([h.score for h in dense_hits])
        bm25_norm = _minmax([h.score for h in bm25_hits])

        merged: Dict[str, Candidate] = {}
        for hit, norm in zip(dense_hits, dense_norm):
            merged[hit.chunk_id] = Candidate(
                chunk_id=hit.chunk_id, payload=hit.payload, dense_score=norm
            )
        for hit, norm in zip(bm25_hits, bm25_norm):
            cand = merged.get(hit.chunk_id)
            if cand is None:
                merged[hit.chunk_id] = Candidate(
                    chunk_id=hit.chunk_id, payload=hit.payload, bm25_score=norm
                )
            else:
                cand.bm25_score = norm

        for cand in merged.values():
            cand.combined_score = (
                self.dense_weight * cand.dense_score
                + self.bm25_weight * cand.bm25_score
            )

        candidates = sorted(
            merged.values(), key=lambda c: c.combined_score, reverse=True
        )
        return HybridResult(
            candidates=candidates,
            dense_count=len(dense_hits),
            bm25_count=len(bm25_hits),
        )

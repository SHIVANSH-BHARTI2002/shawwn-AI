"""Reranking stage.

`Reranker` re-scores (query, chunk) pairs. Two implementations:

* `BGEReranker` - real BGE cross-encoder reranker (full mode).
* `LexicalReranker` - deterministic token-overlap reranker for light mode /
  tests. It produces a bounded [0, 1] relevance score based on query-term
  coverage and density, which is good enough to order candidates and to drive
  the no-answer confidence threshold deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from .bm25 import tokenize


@dataclass
class RankedChunk:
    chunk_id: str
    payload: Dict
    score: float


class Reranker:
    def rerank(self, query: str, candidates: List[Dict], top_k: int) -> List[RankedChunk]:
        raise NotImplementedError


class LexicalReranker(Reranker):
    def rerank(self, query: str, candidates: List[Dict], top_k: int) -> List[RankedChunk]:
        q_terms = set(tokenize(query))
        ranked: List[RankedChunk] = []
        for payload in candidates:
            text = payload.get("text", "")
            d_terms = tokenize(text)
            if not q_terms or not d_terms:
                score = 0.0
            else:
                d_set = set(d_terms)
                coverage = len(q_terms & d_set) / len(q_terms)
                overlap_count = sum(1 for t in d_terms if t in q_terms)
                density = overlap_count / (len(d_terms) or 1)
                # Weighted blend, bounded to [0, 1].
                score = min(1.0, 0.7 * coverage + 0.3 * min(1.0, density * 5))
            ranked.append(RankedChunk(payload["chunk_id"], payload, score))
        ranked.sort(key=lambda r: r.score, reverse=True)
        return ranked[:top_k]


class BGEReranker(Reranker):  # pragma: no cover - depends on optional heavy deps
    def __init__(self, model_name: str):
        from FlagEmbedding import FlagReranker

        self._model = FlagReranker(model_name, use_fp16=True)

    def rerank(self, query: str, candidates: List[Dict], top_k: int) -> List[RankedChunk]:
        if not candidates:
            return []
        pairs = [[query, c.get("text", "")] for c in candidates]
        raw = self._model.compute_score(pairs, normalize=True)
        if not isinstance(raw, list):
            raw = [raw]
        ranked = [
            RankedChunk(c["chunk_id"], c, float(s)) for c, s in zip(candidates, raw)
        ]
        ranked.sort(key=lambda r: r.score, reverse=True)
        return ranked[:top_k]


def build_reranker(settings, light_mode: bool) -> Reranker:
    if light_mode:
        return LexicalReranker()
    try:
        return BGEReranker(settings.reranker_model)
    except Exception:  # pragma: no cover
        from ..core.logging import get_logger

        get_logger("shawwn.reranker").warning(
            "BGE reranker unavailable; using lexical reranker."
        )
        return LexicalReranker()

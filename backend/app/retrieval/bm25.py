"""Lightweight BM25 keyword retrieval.

A dependency-free BM25 Okapi implementation. The index is built per document
from the chunk payloads (fetched from the vector store), which keeps keyword
retrieval isolated to the current page and avoids a separate persistent index
for the MVP.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List

_TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> List[str]:
    return _TOKEN.findall(text.lower())


@dataclass
class BM25Hit:
    chunk_id: str
    score: float
    payload: Dict


class BM25Index:
    def __init__(self, payloads: List[Dict], *, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.payloads = payloads
        self.docs_tokens: List[List[str]] = [tokenize(p.get("text", "")) for p in payloads]
        self.doc_len = [len(t) for t in self.docs_tokens]
        self.avgdl = (sum(self.doc_len) / len(self.doc_len)) if self.doc_len else 0.0
        self.n = len(payloads)

        # document frequency
        self.df: Counter = Counter()
        for tokens in self.docs_tokens:
            for term in set(tokens):
                self.df[term] += 1

        self.tf: List[Counter] = [Counter(t) for t in self.docs_tokens]

    def _idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        if df == 0:
            return 0.0
        # BM25 idf with +1 smoothing to keep it non-negative.
        return math.log(1 + (self.n - df + 0.5) / (df + 0.5))

    def search(self, query: str, top_k: int) -> List[BM25Hit]:
        q_terms = tokenize(query)
        if not q_terms or self.n == 0:
            return []

        scores: List[float] = [0.0] * self.n
        for term in q_terms:
            idf = self._idf(term)
            if idf == 0.0:
                continue
            for i in range(self.n):
                tf = self.tf[i].get(term, 0)
                if tf == 0:
                    continue
                denom = tf + self.k1 * (
                    1 - self.b + self.b * (self.doc_len[i] / (self.avgdl or 1))
                )
                scores[i] += idf * (tf * (self.k1 + 1)) / (denom or 1)

        ranked = sorted(range(self.n), key=lambda i: scores[i], reverse=True)
        hits = []
        for i in ranked[:top_k]:
            if scores[i] <= 0:
                continue
            hits.append(BM25Hit(self.payloads[i]["chunk_id"], scores[i], self.payloads[i]))
        return hits

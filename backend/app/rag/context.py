"""Context builder.

Assembles reranked chunks into a bounded context string for the LLM. Removes
highly-overlapping duplicates and respects a maximum character budget, keeping
the highest-ranked chunks first.
"""

from __future__ import annotations

from typing import List

from ..retrieval.bm25 import tokenize
from ..retrieval.reranker import RankedChunk


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def dedupe_chunks(chunks: List[RankedChunk], threshold: float = 0.85) -> List[RankedChunk]:
    """Drop chunks that are near-duplicates of an already-kept, higher-ranked chunk."""
    kept: List[RankedChunk] = []
    kept_tokens: List[set] = []
    for chunk in chunks:
        toks = set(tokenize(chunk.payload.get("text", "")))
        if any(_jaccard(toks, kt) >= threshold for kt in kept_tokens):
            continue
        kept.append(chunk)
        kept_tokens.append(toks)
    return kept


def build_context(chunks: List[RankedChunk], max_chars: int = 12000) -> str:
    """Format ranked chunks into a numbered, source-labeled context block."""
    blocks: List[str] = []
    used = 0
    for i, chunk in enumerate(chunks, start=1):
        payload = chunk.payload
        heading_path = payload.get("heading_path") or []
        section = payload.get("section") or (heading_path[-1] if heading_path else "")
        header = (
            f"Source {i}:\n"
            f"Title: {payload.get('title', '')}\n"
            f"Section: {section}\n"
            f"URL: {payload.get('url', '')}\n\n"
            f"Content:\n{payload.get('text', '')}"
        )
        if used + len(header) > max_chars and blocks:
            break
        blocks.append(header)
        used += len(header)
    return "\n\n---\n\n".join(blocks)

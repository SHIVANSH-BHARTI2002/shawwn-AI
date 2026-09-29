"""Citation construction from reranked chunks."""

from __future__ import annotations

from typing import List

from ..models.schemas import Citation
from ..retrieval.reranker import RankedChunk

# Cap citation text so we never dump whole chunks into the UI / DB.
_MAX_CITATION_CHARS = 400


def build_citations(chunks: List[RankedChunk]) -> List[Citation]:
    citations: List[Citation] = []
    for chunk in chunks:
        p = chunk.payload
        text = (p.get("text", "") or "").strip()
        # Strip a leading breadcrumb line like "[A > B]".
        if text.startswith("["):
            newline = text.find("\n")
            if newline != -1:
                text = text[newline + 1 :].strip()
        if len(text) > _MAX_CITATION_CHARS:
            text = text[:_MAX_CITATION_CHARS].rsplit(" ", 1)[0] + "…"
        citations.append(
            Citation(
                chunk_id=p.get("chunk_id", ""),
                document_id=p.get("document_id", ""),
                title=p.get("title", ""),
                url=p.get("url", ""),
                section=p.get("section", ""),
                heading_path=p.get("heading_path", []) or [],
                text=text,
                score=round(float(chunk.score), 4),
            )
        )
    return citations

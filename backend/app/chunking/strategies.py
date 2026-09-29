"""Chunk data model and low-level splitting helpers.

We approximate tokens as ~4 characters (a reasonable heuristic for English and
mixed content) to avoid a hard dependency on a tokenizer in light mode. The
chunker targets a token budget but always prefers structural boundaries.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Dict, List

CHARS_PER_TOKEN = 4


@dataclass
class Chunk:
    chunk_id: str
    document_id: str
    text: str
    section: str
    heading_path: List[str]
    chunk_index: int
    metadata: Dict[str, str] = field(default_factory=dict)

    def to_payload(self) -> dict:
        return {
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "text": self.text,
            "section": self.section,
            "heading_path": self.heading_path,
            "chunk_index": self.chunk_index,
            **self.metadata,
        }


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def make_chunk_id(document_id: str, index: int, text: str) -> str:
    h = hashlib.sha256(f"{document_id}:{index}:{text[:64]}".encode("utf-8")).hexdigest()
    return f"{document_id}-{index}-{h[:8]}"


_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str) -> List[str]:
    parts = _SENTENCE.split(text.strip())
    return [p.strip() for p in parts if p.strip()]


def pack_paragraphs(
    paragraphs: List[str], target_tokens: int, overlap_tokens: int
) -> List[str]:
    """Greedily pack paragraphs into chunks up to a token budget.

    A single oversized paragraph is split on sentence boundaries. Overlap is
    applied by carrying trailing sentences into the next chunk.
    """
    chunks: List[str] = []
    current: List[str] = []
    current_tokens = 0

    def flush():
        nonlocal current, current_tokens
        if current:
            chunks.append("\n\n".join(current).strip())
            current = []
            current_tokens = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        ptok = estimate_tokens(para)

        if ptok > target_tokens:
            # Oversized paragraph: split by sentences.
            flush()
            sentences = split_sentences(para) or [para]
            buf: List[str] = []
            buf_tokens = 0
            for sent in sentences:
                stok = estimate_tokens(sent)
                if buf and buf_tokens + stok > target_tokens:
                    chunks.append(" ".join(buf).strip())
                    # sentence-level overlap
                    buf = _tail_by_tokens(buf, overlap_tokens)
                    buf_tokens = sum(estimate_tokens(s) for s in buf)
                buf.append(sent)
                buf_tokens += stok
            if buf:
                chunks.append(" ".join(buf).strip())
            continue

        if current and current_tokens + ptok > target_tokens:
            flush()
        current.append(para)
        current_tokens += ptok

    flush()
    return [c for c in chunks if c]


def _tail_by_tokens(items: List[str], overlap_tokens: int) -> List[str]:
    if overlap_tokens <= 0:
        return []
    tail: List[str] = []
    total = 0
    for item in reversed(items):
        total += estimate_tokens(item)
        tail.insert(0, item)
        if total >= overlap_tokens:
            break
    return tail

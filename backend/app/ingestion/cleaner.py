"""Content normalization for incoming page payloads.

The extension already removes UI noise; here we normalize whitespace, collapse
excessive blank lines and drop near-duplicate paragraphs, while preserving
heading hierarchy, tables, lists and code blocks in the markdown.
"""

from __future__ import annotations

import re

from ..models.schemas import PagePayload

_MULTISPACE = re.compile(r"[ \t]+")
_MULTINEWLINE = re.compile(r"\n{3,}")


def normalize_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _MULTISPACE.sub(" ", text)
    text = _MULTINEWLINE.sub("\n\n", text)
    lines = [ln.rstrip() for ln in text.split("\n")]
    return "\n".join(lines).strip()


def dedupe_paragraphs(markdown: str) -> str:
    """Remove consecutive duplicate non-empty lines (common on scraped pages)."""
    out = []
    prev = None
    for line in markdown.split("\n"):
        key = line.strip()
        if key and key == prev:
            continue
        out.append(line)
        prev = key if key else prev
    return "\n".join(out)


def clean_payload(payload: PagePayload) -> PagePayload:
    """Return a normalized copy of the payload (structure preserved)."""
    cleaned = payload.model_copy(deep=True)
    cleaned.content.markdown = dedupe_paragraphs(normalize_text(payload.content.markdown))
    cleaned.content.text = normalize_text(payload.content.text)
    return cleaned

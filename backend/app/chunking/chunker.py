"""Structure-aware chunking.

Parses the page markdown into sections defined by its heading hierarchy, then
chunks each section's prose to a token budget while keeping tables intact. Each
chunk carries its `heading_path` (breadcrumb of ancestor headings) so citations
can point at a meaningful section.
"""

from __future__ import annotations

import re
from typing import Dict, List

from ..models.schemas import PagePayload
from .strategies import Chunk, estimate_tokens, make_chunk_id, pack_paragraphs

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


class _Block:
    """A run of content: either prose text or an intact table."""

    def __init__(self, kind: str, text: str):
        self.kind = kind  # "text" | "table"
        self.text = text


def _parse_sections(markdown: str):
    """Yield (heading_path, blocks) for each section of the document.

    heading_path is the list of ancestor headings (including the current one).
    Content before the first heading is attributed to an empty path.
    """
    lines = markdown.split("\n")
    stack: List[tuple[int, str]] = []  # (level, text)
    buffer: List[str] = []
    sections: List[tuple[List[str], str]] = []

    def current_path() -> List[str]:
        return [text for _, text in stack]

    def flush():
        content = "\n".join(buffer).strip()
        if content:
            sections.append((current_path(), content))
        buffer.clear()

    for line in lines:
        m = _HEADING.match(line)
        if m:
            flush()
            level = len(m.group(1))
            title = m.group(2).strip()
            # Pop deeper-or-equal headings, then push this one.
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
        else:
            buffer.append(line)
    flush()
    return sections


_TABLE_LINE = re.compile(r"^\s*\|.*\|\s*$")


def _split_blocks(content: str) -> List[_Block]:
    """Separate markdown tables (kept intact) from surrounding prose."""
    blocks: List[_Block] = []
    lines = content.split("\n")
    i = 0
    prose: List[str] = []

    def flush_prose():
        text = "\n".join(prose).strip()
        if text:
            blocks.append(_Block("text", text))
        prose.clear()

    while i < len(lines):
        if _TABLE_LINE.match(lines[i]):
            flush_prose()
            table_lines = []
            while i < len(lines) and _TABLE_LINE.match(lines[i]):
                table_lines.append(lines[i])
                i += 1
            blocks.append(_Block("table", "\n".join(table_lines).strip()))
        else:
            prose.append(lines[i])
            i += 1
    flush_prose()
    return blocks


def chunk_document(
    payload: PagePayload,
    document_id: str,
    *,
    chunk_size: int = 700,
    chunk_overlap: int = 100,
) -> List[Chunk]:
    """Produce structure-aware chunks for a page payload."""
    markdown = payload.content.markdown or payload.content.text or ""
    meta = {
        "url": payload.page.url or payload.page.canonicalUrl,
        "title": payload.page.title,
        "domain": payload.page.domain,
    }

    chunks: List[Chunk] = []
    index = 0

    sections = _parse_sections(markdown)
    if not sections and payload.content.text:
        sections = [([], payload.content.text)]

    for heading_path, content in sections:
        section_name = heading_path[-1] if heading_path else (payload.page.title or "")
        blocks = _split_blocks(content)

        # Group consecutive prose; tables become their own chunks.
        prose_buffer: List[str] = []

        def emit_prose():
            nonlocal index
            if not prose_buffer:
                return
            joined = "\n\n".join(prose_buffer)
            paragraphs = [p for p in joined.split("\n\n") if p.strip()]
            for text in pack_paragraphs(paragraphs, chunk_size, chunk_overlap):
                chunks.append(
                    Chunk(
                        chunk_id=make_chunk_id(document_id, index, text),
                        document_id=document_id,
                        text=_prefix_heading(heading_path, text),
                        section=section_name,
                        heading_path=list(heading_path),
                        chunk_index=index,
                        metadata=dict(meta),
                    )
                )
                index += 1
            prose_buffer.clear()

        for block in blocks:
            if block.kind == "table":
                emit_prose()
                # Keep the table intact; if enormous, still keep as one chunk.
                table_text = _prefix_heading(heading_path, block.text)
                chunks.append(
                    Chunk(
                        chunk_id=make_chunk_id(document_id, index, block.text),
                        document_id=document_id,
                        text=table_text,
                        section=section_name,
                        heading_path=list(heading_path),
                        chunk_index=index,
                        metadata={**meta, "type": "table"},
                    )
                )
                index += 1
            else:
                prose_buffer.append(block.text)
        emit_prose()

    return chunks


def _prefix_heading(heading_path: List[str], text: str) -> str:
    """Prepend the section breadcrumb so each chunk is self-describing."""
    if not heading_path:
        return text
    breadcrumb = " > ".join(heading_path)
    return f"[{breadcrumb}]\n{text}"

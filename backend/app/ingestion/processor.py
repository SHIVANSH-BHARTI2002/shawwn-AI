"""Document processing orchestrator: validate -> clean -> metadata -> chunk."""

from __future__ import annotations

from typing import List, Tuple

from ..chunking.chunker import chunk_document
from ..chunking.strategies import Chunk
from ..core.errors import ValidationError
from ..models.schemas import PagePayload
from .cleaner import clean_payload
from .metadata import extract_metadata


def process_document(
    payload: PagePayload, *, chunk_size: int = 700, chunk_overlap: int = 100
) -> Tuple[dict, List[Chunk]]:
    """Return (metadata dict, chunks) for a validated page payload.

    Raises ValidationError for empty/unusable payloads.
    """
    text = (payload.content.text or "").strip()
    markdown = (payload.content.markdown or "").strip()
    if not text and not markdown:
        raise ValidationError("The page has no extractable content to index.")

    # Identity is derived from the ORIGINAL payload (stable, client-reproducible).
    meta = extract_metadata(payload)
    # Cleaning affects only the text we chunk/embed, not the document identity.
    cleaned = clean_payload(payload)
    chunks = chunk_document(
        cleaned,
        meta["document_id"],
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )
    if not chunks:
        raise ValidationError("The page produced no chunks.")
    return meta, chunks

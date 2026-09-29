"""Metadata extraction and stable document identity.

The document id is derived from the canonical URL (or URL) plus a content hash,
so the *same page with the same content* maps to the same id, while a content
change produces a new id — enabling duplicate detection and re-indexing.
"""

from __future__ import annotations

import hashlib
from urllib.parse import urlsplit, urlunsplit

from ..models.schemas import PagePayload


def normalize_url(url: str) -> str:
    """Normalize a URL for identity: drop fragments, lowercase host, strip trailing slash."""
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        netloc = parts.netloc.lower()
        path = parts.path.rstrip("/") or "/"
        # Drop the fragment; keep the query (it can be content-relevant).
        return urlunsplit((scheme, netloc, path, parts.query, ""))
    except Exception:
        return url.strip()


def content_hash(payload: PagePayload) -> str:
    """SHA-256 over the meaningful content (text + markdown + title)."""
    hasher = hashlib.sha256()
    hasher.update((payload.page.title or "").encode("utf-8"))
    hasher.update(b"\x00")
    hasher.update((payload.content.text or "").encode("utf-8"))
    hasher.update(b"\x00")
    hasher.update((payload.content.markdown or "").encode("utf-8"))
    return hasher.hexdigest()


def make_document_id(canonical_or_url: str, chash: str) -> str:
    """Stable id from normalized URL + content hash."""
    key = f"{normalize_url(canonical_or_url)}::{chash}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def extract_metadata(payload: PagePayload) -> dict:
    """Collect the fields we persist for a document."""
    page = payload.page
    url = page.url or page.canonicalUrl
    canonical = page.canonicalUrl or url
    chash = content_hash(payload)
    doc_id = make_document_id(canonical, chash)
    return {
        "document_id": doc_id,
        "url": url,
        "canonical_url": canonical,
        "title": page.title,
        "domain": page.domain,
        "language": page.language,
        "content_hash": chash,
    }

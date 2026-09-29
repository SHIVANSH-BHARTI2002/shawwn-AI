"""Chunking, metadata and content-hash unit tests."""

from app.ingestion.metadata import content_hash, make_document_id, normalize_url
from app.ingestion.processor import process_document
from app.models.schemas import PagePayload


def _payload(d):
    return PagePayload(**d)


def test_content_hash_stable_and_sensitive(laptop_payload):
    p1 = _payload(laptop_payload)
    h1 = content_hash(p1)
    h2 = content_hash(_payload(laptop_payload))
    assert h1 == h2  # deterministic

    changed = dict(laptop_payload)
    changed["content"] = dict(laptop_payload["content"])
    changed["content"]["text"] = laptop_payload["content"]["text"] + " extra"
    assert content_hash(_payload(changed)) != h1  # content-sensitive


def test_document_id_depends_on_url_and_hash():
    a = make_document_id("https://x.com/a", "hash1")
    b = make_document_id("https://x.com/a", "hash2")
    c = make_document_id("https://x.com/b", "hash1")
    assert a != b and a != c


def test_normalize_url_drops_fragment_and_trailing_slash():
    assert normalize_url("https://X.com/Path/#frag") == "https://x.com/Path"


def test_chunking_preserves_headings(laptop_payload):
    meta, chunks = process_document(_payload(laptop_payload))
    # Every section heading should appear in some chunk's heading_path.
    all_headings = {h for c in chunks for h in c.heading_path}
    assert "Processor" in all_headings
    assert "RAM" in all_headings
    assert "Battery" in all_headings


def test_chunking_preserves_table_intact(laptop_payload):
    meta, chunks = process_document(_payload(laptop_payload))
    table_chunks = [c for c in chunks if c.metadata.get("type") == "table"]
    assert len(table_chunks) == 1
    text = table_chunks[0].text
    # Both data rows must survive in the same chunk (no mid-table split).
    assert "Model A" in text and "Model B" in text
    assert "| Model | RAM | Storage | Price |" in text


def test_chunk_payload_shape(laptop_payload):
    meta, chunks = process_document(_payload(laptop_payload))
    payload = chunks[0].to_payload()
    for key in ("chunk_id", "document_id", "text", "section", "heading_path", "chunk_index"):
        assert key in payload


def test_empty_document_rejected():
    import pytest
    from app.core.errors import ValidationError

    empty = {
        "page": {"title": "", "url": "https://e.com", "domain": "e.com"},
        "content": {"markdown": "", "text": "", "wordCount": 0, "characterCount": 0},
        "structure": {},
        "metadata": {},
    }
    with pytest.raises(ValidationError):
        process_document(_payload(empty))

"""Embedding, vector store, BM25, hybrid and reranker unit tests."""

from app.embeddings.bge import HashingEmbeddingService
from app.retrieval.bm25 import BM25Index
from app.retrieval.hybrid import HybridRetriever
from app.retrieval.reranker import LexicalReranker
from app.retrieval.vector import InMemoryVectorStore


def _payloads():
    return [
        {"chunk_id": "c1", "document_id": "d1", "text": "Intel Core Ultra 7 155H processor"},
        {"chunk_id": "c2", "document_id": "d1", "text": "16GB DDR5 RAM memory"},
        {"chunk_id": "c3", "document_id": "d1", "text": "1TB SSD storage"},
        {"chunk_id": "c4", "document_id": "d2", "text": "A different document about cameras"},
    ]


def test_hashing_embeddings_deterministic_and_normalized():
    svc = HashingEmbeddingService(dim=64)
    v1 = svc.embed_query("processor")
    v2 = svc.embed_query("processor")
    assert v1 == v2
    norm = sum(x * x for x in v1) ** 0.5
    assert abs(norm - 1.0) < 1e-6


def test_vector_store_document_isolation():
    svc = HashingEmbeddingService(dim=64)
    store = InMemoryVectorStore(dim=64)
    payloads = _payloads()
    vectors = svc.embed_documents([p["text"] for p in payloads])
    store.upsert(vectors, payloads)

    hits = store.search(svc.embed_query("processor"), document_id="d1", top_k=5)
    assert all(h.payload["document_id"] == "d1" for h in hits)
    assert "c4" not in [h.chunk_id for h in hits]


def test_bm25_matches_exact_terms():
    idx = BM25Index([p for p in _payloads() if p["document_id"] == "d1"])
    hits = idx.search("155H processor", top_k=3)
    assert hits[0].chunk_id == "c1"


def test_hybrid_merges_and_dedupes():
    svc = HashingEmbeddingService(dim=64)
    store = InMemoryVectorStore(dim=64)
    payloads = _payloads()
    store.upsert(svc.embed_documents([p["text"] for p in payloads]), payloads)

    retriever = HybridRetriever(store, svc, dense_weight=0.7, bm25_weight=0.3)
    result = retriever.retrieve("16GB RAM", "d1", top_k_dense=5, top_k_bm25=5)
    ids = [c.chunk_id for c in result.candidates]
    assert len(ids) == len(set(ids))  # no duplicates
    assert "c2" in ids  # RAM chunk retrieved
    assert "c4" not in ids  # isolation holds


def test_reranker_orders_by_relevance():
    reranker = LexicalReranker()
    ranked = reranker.rerank(
        "storage capacity SSD",
        [p for p in _payloads() if p["document_id"] == "d1"],
        top_k=3,
    )
    assert ranked[0].chunk_id == "c3"
    assert 0.0 <= ranked[0].score <= 1.0

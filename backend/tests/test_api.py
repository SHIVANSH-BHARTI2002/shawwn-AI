"""API-level tests exercising the full stack in light mode via ASGI transport."""

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.models.database import init_db


@pytest_asyncio.fixture
async def client():
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mode"] == "light"


@pytest.mark.asyncio
async def test_document_index_and_duplicate_detection(client, laptop_payload):
    r1 = await client.post("/api/v1/documents", json=laptop_payload)
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["status"] == "indexed"
    assert d1["chunk_count"] > 0
    doc_id = d1["document_id"]

    # Re-indexing the same content returns the same id and is marked reused.
    r2 = await client.post("/api/v1/documents", json=laptop_payload)
    d2 = r2.json()
    assert d2["document_id"] == doc_id
    assert d2["reused"] is True


@pytest.mark.asyncio
async def test_document_check(client, laptop_payload):
    from app.ingestion.metadata import content_hash
    from app.models.schemas import PagePayload

    await client.post("/api/v1/documents", json=laptop_payload)
    chash = content_hash(PagePayload(**laptop_payload))
    r = await client.get(
        "/api/v1/documents/check",
        params={"url": laptop_payload["page"]["url"], "content_hash": chash},
    )
    body = r.json()
    assert body["exists"] is True


@pytest.mark.asyncio
async def test_get_document(client, laptop_payload):
    r = await client.post("/api/v1/documents", json=laptop_payload)
    doc_id = r.json()["document_id"]
    g = await client.get(f"/api/v1/documents/{doc_id}")
    assert g.status_code == 200
    assert g.json()["title"] == "Laptop"


@pytest.mark.asyncio
async def test_chat_flow_and_conversation(client, laptop_payload):
    r = await client.post("/api/v1/documents", json=laptop_payload)
    doc_id = r.json()["document_id"]

    chat = await client.post(
        "/api/v1/chat",
        json={"document_id": doc_id, "message": "What processor does the laptop use?"},
    )
    assert chat.status_code == 200
    body = chat.json()
    assert "Intel Core Ultra 7 155H" in body["answer"]
    assert body["grounded"] is True
    assert len(body["citations"]) > 0
    conv_id = body["conversation_id"]

    # Follow-up in the same conversation.
    chat2 = await client.post(
        "/api/v1/chat",
        json={
            "document_id": doc_id,
            "message": "How much RAM?",
            "conversation_id": conv_id,
        },
    )
    assert "16GB" in chat2.json()["answer"]

    # Conversation history contains both turns.
    conv = await client.get(f"/api/v1/conversations/{conv_id}")
    roles = [m["role"] for m in conv.json()["messages"]]
    assert roles.count("user") == 2
    assert roles.count("assistant") == 2


@pytest.mark.asyncio
async def test_chat_no_answer(client, laptop_payload):
    r = await client.post("/api/v1/documents", json=laptop_payload)
    doc_id = r.json()["document_id"]
    chat = await client.post(
        "/api/v1/chat",
        json={"document_id": doc_id, "message": "Does it support wireless charging?"},
    )
    body = chat.json()
    assert "couldn't find" in body["answer"].lower()
    assert body["grounded"] is False


@pytest.mark.asyncio
async def test_chat_invalid_document(client):
    chat = await client.post(
        "/api/v1/chat",
        json={"document_id": "does-not-exist", "message": "hello"},
    )
    assert chat.status_code == 404
    assert chat.json()["error"]["code"] == "DOCUMENT_NOT_FOUND"


@pytest.mark.asyncio
async def test_invalid_chat_request_validation(client):
    r = await client.post("/api/v1/chat", json={"document_id": "x"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_document_deletion(client, laptop_payload):
    r = await client.post("/api/v1/documents", json=laptop_payload)
    doc_id = r.json()["document_id"]
    d = await client.delete(f"/api/v1/documents/{doc_id}")
    assert d.status_code == 200
    g = await client.get(f"/api/v1/documents/{doc_id}")
    assert g.status_code == 404


@pytest.mark.asyncio
async def test_search_endpoint(client, laptop_payload):
    r = await client.post("/api/v1/documents", json=laptop_payload)
    doc_id = r.json()["document_id"]
    s = await client.post(
        "/api/v1/search",
        json={"document_id": doc_id, "query": "battery", "top_k": 3},
    )
    assert s.status_code == 200
    assert len(s.json()["results"]) > 0

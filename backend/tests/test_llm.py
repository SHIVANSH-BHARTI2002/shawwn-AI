"""Tests for LLM provider selection and multimodal attachment plumbing."""

import pytest

from app.core.config import Settings
from app.llm import build_llm
from app.llm.base import Attachment, LLMMessage, LLMProvider
from app.llm.gemini import GeminiProvider, _extract_text


def test_extractive_when_no_key():
    s = Settings(_env_file=None, SHAWWN_LIGHT_MODE=True, GEMINI_API_KEY="", OPENAI_API_KEY="")
    assert type(build_llm(s, True)).__name__ == "ExtractiveProvider"


def test_gemini_selected_when_only_gemini_key():
    s = Settings(_env_file=None, LLM_PROVIDER="gemini", GEMINI_API_KEY="x")
    llm = build_llm(s, True)
    assert isinstance(llm, GeminiProvider)
    assert llm.supports_attachments is True


def test_mistral_selected_when_only_mistral_key():
    from app.llm.mistral import MistralProvider

    s = Settings(_env_file=None, LLM_PROVIDER="mistral", MISTRAL_API_KEY="x")
    llm = build_llm(s, True)
    assert isinstance(llm, MistralProvider)


def test_fallback_chain_when_multiple_keys():
    from app.llm import FallbackProvider

    s = Settings(
        _env_file=None, LLM_PROVIDER="gemini", GEMINI_API_KEY="g", MISTRAL_API_KEY="m"
    )
    llm = build_llm(s, True)
    assert isinstance(llm, FallbackProvider)
    # Gemini (multimodal) makes the chain multimodal-capable.
    assert llm.supports_attachments is True
    assert llm.providers[0].name == "gemini"


def test_gemini_contents_include_attachments():
    provider = GeminiProvider("x", "gemini-flash-latest")
    msgs = [
        LLMMessage(
            role="user",
            content="What is in this image?",
            attachments=[Attachment(mime_type="image/png", data_b64="QUJD", name="a.png")],
        )
    ]
    contents = provider._contents(msgs)
    assert contents[0]["role"] == "user"
    kinds = contents[0]["parts"]
    assert any("text" in p for p in kinds)
    assert any("inline_data" in p for p in kinds)
    assert kinds[-1]["inline_data"]["mime_type"] == "image/png"


def test_gemini_extract_text():
    data = {"candidates": [{"content": {"parts": [{"text": "Hello "}, {"text": "world"}]}}]}
    assert _extract_text(data) == "Hello world"
    assert _extract_text({"candidates": []}) == ""


class _FakeMultimodalLLM(LLMProvider):
    name = "fake"
    supports_attachments = True

    def __init__(self):
        self.last_attachments = None

    async def generate(self, system_prompt, messages, temperature=0.0):
        # Echo whether attachments arrived, for assertion.
        last = messages[-1]
        self.last_attachments = last.attachments
        if last.attachments:
            return f"I can see {len(last.attachments)} attached file(s)."
        return "No files attached."


class _FailingLLM(LLMProvider):
    name = "failing"

    async def generate(self, system_prompt, messages, temperature=0.0):
        return "Sorry, I ran into a problem reaching the AI service. Please try again."


class _GoodLLM(LLMProvider):
    name = "good"

    async def generate(self, system_prompt, messages, temperature=0.0):
        return "Here is a real answer."


@pytest.mark.asyncio
async def test_fallback_skips_failing_provider():
    from app.llm import FallbackProvider

    chain = FallbackProvider([_FailingLLM(), _GoodLLM()])
    out = await chain.generate("sys", [LLMMessage("user", "hi")], 0.4)
    assert out == "Here is a real answer."


@pytest.mark.asyncio
async def test_pipeline_forwards_attachments(laptop_payload):
    from app.embeddings.bge import HashingEmbeddingService
    from app.ingestion.processor import process_document
    from app.models.schemas import PagePayload
    from app.rag.pipeline import RagConfig, RagPipeline
    from app.retrieval.hybrid import HybridRetriever
    from app.retrieval.reranker import LexicalReranker
    from app.retrieval.vector import InMemoryVectorStore

    payload = PagePayload(**laptop_payload)
    meta, chunks = process_document(payload)
    doc_id = meta["document_id"]
    embedder = HashingEmbeddingService(dim=128)
    store = InMemoryVectorStore(dim=128)
    payloads = []
    for c in chunks:
        p = c.to_payload()
        p["title"] = meta["title"]
        payloads.append(p)
    store.upsert(embedder.embed_documents([p["text"] for p in payloads]), payloads)

    fake = _FakeMultimodalLLM()
    pipe = RagPipeline(
        HybridRetriever(store, embedder), LexicalReranker(), fake, RagConfig(), temperature=0.4
    )
    result = await pipe.answer(
        document_id=doc_id,
        question="What does this file say?",
        attachments=[Attachment(mime_type="application/pdf", data_b64="QUJD", name="d.pdf")],
    )
    assert fake.last_attachments and len(fake.last_attachments) == 1
    assert "attached file" in result.answer

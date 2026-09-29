"""Transparent RAG evaluation harness.

Indexes the dataset's document, runs each question through the real RAG pipeline
and reports simple, honest metrics:

  * answer_match      - expected substring present in the answer
  * source_correct    - expected section appears among the citations
  * no_answer_correct - "no answer" behavior matches expectation
  * retrieval_recall  - fraction of answerable questions whose expected source
                        was retrieved among the citations

We do NOT use an LLM to grade itself. Metrics are deterministic string checks so
results are reproducible. Runs in light mode by default (no external services);
set SHAWWN_LIGHT_MODE=false with the ML stack + services for a full-mode eval.

Usage:
    python -m evaluation.evaluate
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

os.environ.setdefault("SHAWWN_LIGHT_MODE", "true")
# Evaluation is deterministic: use the offline extractive provider, not a hosted
# LLM (whose phrasing varies and would make string-based metrics unreliable).
# Set SHAWWN_EVAL_USE_LLM=1 to evaluate against the configured LLM instead.
if os.environ.get("SHAWWN_EVAL_USE_LLM") != "1":
    os.environ["GEMINI_API_KEY"] = ""
    os.environ["OPENAI_API_KEY"] = ""
    os.environ["MISTRAL_API_KEY"] = ""
    os.environ["LLM_PROVIDER"] = "none"

from app.embeddings.bge import build_embedder  # noqa: E402
from app.ingestion.processor import process_document  # noqa: E402
from app.llm import build_llm  # noqa: E402
from app.models.schemas import PagePayload  # noqa: E402
from app.rag.pipeline import RagConfig, RagPipeline  # noqa: E402
from app.retrieval.hybrid import HybridRetriever  # noqa: E402
from app.retrieval.reranker import build_reranker  # noqa: E402
from app.retrieval.vector import build_vector_store  # noqa: E402
from app.core.config import get_settings  # noqa: E402

DATASET = Path(__file__).parent / "dataset.json"


def build_pipeline(document: dict):
    settings = get_settings()
    light = True  # evaluation defaults to deterministic light mode

    payload = PagePayload(**document)
    meta, chunks = process_document(payload)
    doc_id = meta["document_id"]

    embedder = build_embedder(settings, light)
    store = build_vector_store(settings, embedder.dim, light)
    store.ensure_collection()

    payloads = []
    for c in chunks:
        p = c.to_payload()
        p["title"] = meta["title"]
        p["url"] = meta["url"]
        p["domain"] = meta["domain"]
        payloads.append(p)
    store.upsert(embedder.embed_documents([p["text"] for p in payloads]), payloads)

    pipeline = RagPipeline(
        retriever=HybridRetriever(store, embedder),
        reranker=build_reranker(settings, light),
        llm=build_llm(settings, light),
        config=RagConfig(),
    )
    return pipeline, doc_id


async def run() -> int:
    data = json.loads(DATASET.read_text())
    pipeline, doc_id = build_pipeline(data["document"])

    total = len(data["questions"])
    answer_matches = 0
    source_correct = 0
    no_answer_correct = 0
    answerable = 0
    recall_hits = 0

    print(f"\nEvaluating {total} questions (document_id={doc_id})\n" + "-" * 64)

    for item in data["questions"]:
        q = item["question"]
        result = await pipeline.answer(document_id=doc_id, question=q)
        answer = result.answer
        expect_answer = item.get("expect_answer", True)
        expected = item.get("expected_answer_contains", "")
        expected_source = item.get("expected_source")

        match = expected.lower() in answer.lower()
        answer_matches += int(match)

        sources = [c.section for c in result.citations]
        src_ok = True
        if expect_answer and expected_source:
            answerable += 1
            src_ok = expected_source in sources
            source_correct += int(src_ok)
            recall_hits += int(expected_source in sources)

        if not expect_answer:
            no_answer_correct += int(not result.grounded)

        status = "PASS" if match else "FAIL"
        print(f"[{status}] {q}")
        print(f"        answer: {answer[:80]}")
        if expect_answer and expected_source:
            print(f"        source expected={expected_source} got={sources} ok={src_ok}")
        print()

    print("-" * 64)
    print("Metrics")
    print(f"  answer_match      : {answer_matches}/{total}")
    if answerable:
        print(f"  source_correct    : {source_correct}/{answerable}")
        print(f"  retrieval_recall  : {recall_hits}/{answerable} "
              f"({recall_hits / answerable:.0%})")
    no_answer_total = sum(1 for x in data["questions"] if not x.get("expect_answer", True))
    print(f"  no_answer_correct : {no_answer_correct}/{no_answer_total}")

    # Success criterion: every question behaves as expected.
    ok = answer_matches == total
    print(f"\nResult: {'ALL PASS' if ok else 'SOME FAILURES'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))

"""Core RAG pipeline: retrieve -> rerank -> confidence gate -> context -> LLM.

Kept intentionally simple and framework-free so the flow is easy to follow.
Conversation history is used only to resolve references (via optional query
rewriting); factual grounding always comes from freshly retrieved context.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

from ..core.logging import get_logger, timed
from ..llm.base import Attachment, LLMMessage, LLMProvider
from ..llm.prompts import (
    CONVERSATIONAL_SYSTEM_PROMPT,
    NO_ANSWER_TEXT,
    NO_RELEVANT_TEXT,
    SYSTEM_PROMPT,
    build_summary_prompt,
    build_user_prompt,
)
from ..models.schemas import Citation, RetrievalMeta
from ..retrieval.hybrid import HybridRetriever
from ..retrieval.reranker import RankedChunk, Reranker
from .citations import build_citations
from .context import build_context, dedupe_chunks

logger = get_logger("shawwn.rag")

_SUMMARY_PATTERNS = re.compile(
    r"\b(summar(y|ize|ise)|overview|tl;?dr|what('?s| is) this page about|key points)\b",
    re.I,
)


@dataclass
class RagConfig:
    top_k_dense: int = 10
    top_k_bm25: int = 10
    top_k_rerank: int = 5
    rerank_threshold: float = 0.0
    max_context_chars: int = 12000


@dataclass
class RagResult:
    answer: str
    citations: List[Citation]
    retrieval: RetrievalMeta
    grounded: bool


class RagPipeline:
    def __init__(
        self,
        retriever: HybridRetriever,
        reranker: Reranker,
        llm: LLMProvider,
        config: RagConfig,
        *,
        temperature: float = 0.4,
    ):
        self.retriever = retriever
        self.reranker = reranker
        self.llm = llm
        self.config = config
        self.temperature = temperature
        # Extractive provider is strictly extractive; hosted models get the
        # human-like conversational prompt.
        self._conversational = getattr(llm, "name", "") != "extractive"

    def is_summary_query(self, message: str) -> bool:
        return bool(_SUMMARY_PATTERNS.search(message or ""))

    async def answer(
        self,
        *,
        document_id: str,
        question: str,
        history: Optional[List[LLMMessage]] = None,
        attachments: Optional[List[Attachment]] = None,
    ) -> RagResult:
        cfg = self.config
        summary_mode = self.is_summary_query(question)
        has_files = bool(attachments)

        # Broaden retrieval for summaries so multiple sections are represented.
        top_dense = cfg.top_k_dense * 2 if summary_mode else cfg.top_k_dense
        top_bm25 = cfg.top_k_bm25 * 2 if summary_mode else cfg.top_k_bm25

        with timed(logger, "retrieval"):
            hybrid = self.retriever.retrieve(
                question, document_id, top_k_dense=top_dense, top_k_bm25=top_bm25
            )

        candidates = [c.payload for c in hybrid.candidates]
        meta = RetrievalMeta(
            dense_results=hybrid.dense_count,
            bm25_results=hybrid.bm25_count,
            hybrid_candidates=len(candidates),
        )

        # With no retrievable page context AND no attachments, there is nothing
        # to ground on. If files are attached, we can still answer from them.
        if not candidates and not has_files:
            return RagResult(NO_RELEVANT_TEXT, [], meta, grounded=False)

        ranked: List[RankedChunk] = []
        if candidates:
            top_rerank = max(cfg.top_k_rerank, 8) if summary_mode else cfg.top_k_rerank
            with timed(logger, "reranking"):
                ranked = self.reranker.rerank(question, candidates, top_rerank)
            ranked = dedupe_chunks(ranked)
            meta.reranked_results = len(ranked)
            meta.top_score = round(ranked[0].score, 4) if ranked else 0.0

        # Confidence gate: skip for summaries (broad) and when files are attached
        # (the answer may live in the file, not the page text).
        low_conf = (not ranked) or meta.top_score < cfg.rerank_threshold
        if not summary_mode and not has_files and low_conf:
            return RagResult(NO_RELEVANT_TEXT, [], meta, grounded=False)

        context = build_context(ranked, cfg.max_context_chars) if ranked else ""

        if summary_mode:
            user_prompt = build_summary_prompt(context)
        elif not context and has_files:
            user_prompt = (
                f"User question: {question}\n\n"
                "Answer using the attached file(s). If they don't contain the "
                "answer, say so honestly."
            )
        else:
            user_prompt = build_user_prompt(context, question)

        system_prompt = CONVERSATIONAL_SYSTEM_PROMPT if self._conversational else SYSTEM_PROMPT
        temperature = self.temperature if self._conversational else 0.0

        messages: List[LLMMessage] = []
        if history:
            messages.extend(history)
        messages.append(
            LLMMessage(role="user", content=user_prompt, attachments=attachments or [])
        )

        with timed(logger, "llm"):
            answer = await self.llm.generate(
                system_prompt, messages, temperature=temperature
            )

        answer = (answer or "").strip() or NO_ANSWER_TEXT
        grounded = not _is_no_answer(answer)
        citations = build_citations(ranked) if (grounded and ranked) else []
        return RagResult(answer, citations, meta, grounded=grounded)


def _is_no_answer(answer: str) -> bool:
    low = answer.lower()
    return (
        NO_ANSWER_TEXT.lower() in low
        or NO_RELEVANT_TEXT.lower() in low
        or "couldn't find" in low
        or "could not find" in low
    )

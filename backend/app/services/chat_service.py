"""Chat service: orchestrates conversations + the RAG pipeline.

Persists conversation turns, provides recent history to the pipeline for
reference resolution, and stores assistant answers with their citations.
"""

from __future__ import annotations

from typing import List, Optional

from sqlalchemy import select

from ..core.errors import (
    ConversationNotFound,
    DocumentNotFound,
    NeedsReindex,
    ValidationError,
)
from ..llm.base import Attachment as LLMAttachment
from ..llm.base import LLMMessage
from ..models.database import (
    Conversation,
    Document,
    Message,
    get_session_factory,
    iso,
)
from ..models.schemas import (
    ChatResponse,
    Citation,
    ConversationOut,
    MessageOut,
    SearchResponse,
    SearchResultItem,
)
from ..rag.pipeline import RagConfig, RagPipeline
from ..retrieval.hybrid import HybridRetriever
from .runtime import get_runtime

# How many recent turns to feed the pipeline for reference resolution.
_HISTORY_TURNS = 4

# Attachment limits (base64 length ≈ 4/3 of raw bytes).
_ALLOWED_MIME_PREFIXES = ("image/", "application/pdf")
_MAX_ATTACHMENTS = 5
_MAX_ATTACHMENT_B64 = 15 * 1024 * 1024  # ~11 MB raw per file


class ChatService:
    def __init__(self):
        self.runtime = get_runtime()
        settings = self.runtime.settings
        self.pipeline = RagPipeline(
            retriever=HybridRetriever(
                self.runtime.vector_store(),
                self.runtime.embedder(),
                dense_weight=settings.dense_weight,
                bm25_weight=settings.bm25_weight,
            ),
            reranker=self.runtime.reranker(),
            llm=self.runtime.llm(),
            config=RagConfig(
                top_k_dense=settings.top_k_dense,
                top_k_bm25=settings.top_k_bm25,
                top_k_rerank=settings.top_k_rerank,
                rerank_threshold=settings.rerank_score_threshold,
                max_context_chars=settings.max_context_chars,
            ),
            temperature=settings.llm_temperature,
        )

    async def chat(
        self,
        *,
        document_id: str,
        message: str,
        conversation_id: Optional[str],
        attachments: Optional[list] = None,
    ) -> ChatResponse:
        await self._require_document(document_id)

        conversation = await self._get_or_create_conversation(
            document_id, conversation_id
        )
        history = await self._recent_history(conversation.id)

        # Note attachment names in the stored user turn (never store raw bytes).
        stored_msg = message
        if attachments:
            names = ", ".join(a.name or a.mime_type for a in attachments)
            stored_msg = f"{message}\n[attached: {names}]"
        await self._add_message(conversation.id, "user", stored_msg)

        llm_attachments = self._prepare_attachments(attachments)

        result = await self.pipeline.answer(
            document_id=document_id,
            question=message,
            history=history,
            attachments=llm_attachments,
        )

        await self._add_message(
            conversation.id,
            "assistant",
            result.answer,
            citations=[c.model_dump() for c in result.citations],
            retrieval=result.retrieval.model_dump(),
        )

        return ChatResponse(
            answer=result.answer,
            citations=result.citations,
            retrieval=result.retrieval,
            conversation_id=conversation.id,
            grounded=result.grounded,
        )

    async def search(self, *, document_id: str, query: str, top_k: int) -> SearchResponse:
        await self._require_document(document_id)
        settings = self.runtime.settings
        hybrid = self.pipeline.retriever.retrieve(
            query,
            document_id,
            top_k_dense=settings.top_k_dense,
            top_k_bm25=settings.top_k_bm25,
        )
        ranked = self.pipeline.reranker.rerank(
            query, [c.payload for c in hybrid.candidates], top_k
        )
        results = [
            SearchResultItem(
                chunk_id=r.chunk_id,
                text=r.payload.get("text", ""),
                section=r.payload.get("section", ""),
                heading_path=r.payload.get("heading_path", []) or [],
                score=round(float(r.score), 4),
            )
            for r in ranked
        ]
        from ..models.schemas import RetrievalMeta

        meta = RetrievalMeta(
            dense_results=hybrid.dense_count,
            bm25_results=hybrid.bm25_count,
            hybrid_candidates=len(hybrid.candidates),
            reranked_results=len(ranked),
            top_score=results[0].score if results else 0.0,
        )
        return SearchResponse(results=results, retrieval=meta)

    async def get_conversation(self, conversation_id: str) -> ConversationOut:
        factory = get_session_factory()
        async with factory() as session:
            conv = await session.get(Conversation, conversation_id)
            if not conv:
                raise ConversationNotFound("The requested conversation was not found.")
            rows = (
                await session.execute(
                    select(Message)
                    .where(Message.conversation_id == conversation_id)
                    .order_by(Message.created_at)
                )
            ).scalars().all()
            messages = [
                MessageOut(
                    message_id=m.id,
                    role=m.role,
                    content=m.content,
                    citations=[Citation(**c) for c in (m.citations_json or [])],
                    created_at=iso(m.created_at),
                )
                for m in rows
            ]
            return ConversationOut(
                conversation_id=conv.id,
                document_id=conv.document_id,
                created_at=iso(conv.created_at),
                updated_at=iso(conv.updated_at),
                messages=messages,
            )

    async def delete_conversation(self, conversation_id: str) -> None:
        factory = get_session_factory()
        async with factory() as session:
            conv = await session.get(Conversation, conversation_id)
            if not conv:
                raise ConversationNotFound("The requested conversation was not found.")
            await session.delete(conv)
            await session.commit()

    # ---- helpers -------------------------------------------------------- #
    async def _require_document(self, document_id: str) -> None:
        factory = get_session_factory()
        async with factory() as session:
            doc = await session.get(Document, document_id)
            if not doc or doc.status != "indexed":
                raise DocumentNotFound(
                    "The document is not indexed. Analyze the page first."
                )
        # Guard against an empty vector store (e.g. in-memory store lost its data
        # after a backend restart). Signal the client to re-index and retry.
        try:
            chunks = self.runtime.vector_store().get_document_chunks(document_id)
        except Exception:
            chunks = []
        if not chunks:
            raise NeedsReindex(
                "This page needs to be re-analyzed before I can answer."
            )

    def _prepare_attachments(self, attachments) -> List[LLMAttachment]:
        """Validate and convert incoming attachments into LLM attachments."""
        items = list(attachments or [])
        if not items:
            return []
        if len(items) > _MAX_ATTACHMENTS:
            raise ValidationError(f"Too many files (max {_MAX_ATTACHMENTS}).")

        prepared: List[LLMAttachment] = []
        for a in items:
            mime = (a.mime_type or "").lower()
            if not mime.startswith(_ALLOWED_MIME_PREFIXES):
                raise ValidationError(
                    "Only images and PDF files are supported."
                )
            if len(a.data_b64) > _MAX_ATTACHMENT_B64:
                raise ValidationError("A file is too large (max ~11 MB).")
            prepared.append(
                LLMAttachment(mime_type=mime, data_b64=a.data_b64, name=a.name or "")
            )

        # If the active provider can't read files, ignore them rather than fail.
        if not getattr(self.pipeline.llm, "supports_attachments", False):
            return []
        return prepared

    async def _get_or_create_conversation(
        self, document_id: str, conversation_id: Optional[str]
    ) -> Conversation:
        factory = get_session_factory()
        async with factory() as session:
            if conversation_id:
                conv = await session.get(Conversation, conversation_id)
                if conv:
                    return conv
            conv = Conversation(document_id=document_id)
            session.add(conv)
            await session.commit()
            await session.refresh(conv)
            return conv

    async def _recent_history(self, conversation_id: str) -> List[LLMMessage]:
        factory = get_session_factory()
        async with factory() as session:
            rows = (
                await session.execute(
                    select(Message)
                    .where(Message.conversation_id == conversation_id)
                    .order_by(Message.created_at.desc())
                    .limit(_HISTORY_TURNS * 2)
                )
            ).scalars().all()
        rows = list(reversed(rows))
        return [LLMMessage(role=m.role, content=m.content) for m in rows]

    async def _add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        citations: Optional[list] = None,
        retrieval: Optional[dict] = None,
    ) -> None:
        factory = get_session_factory()
        async with factory() as session:
            msg = Message(
                conversation_id=conversation_id,
                role=role,
                content=content,
                citations_json=citations or [],
                retrieval_json=retrieval or {},
            )
            session.add(msg)
            # Touch conversation.updated_at
            conv = await session.get(Conversation, conversation_id)
            if conv:
                from ..models.database import _now

                conv.updated_at = _now()
            await session.commit()

"""Document service: indexing, duplicate detection, retrieval, deletion.

Handles the full lifecycle: NEW -> PROCESSING -> CHUNKING -> EMBEDDING ->
INDEXED (or FAILED), duplicate detection via (url, content_hash), and cleanup
of obsolete chunks when a page's content changes.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import select

from ..core.errors import DocumentNotFound
from ..core.logging import get_logger, timed
from ..ingestion.metadata import content_hash, normalize_url
from ..ingestion.processor import process_document
from ..models.database import Document, get_session_factory, iso
from ..models.schemas import (
    DocumentIndexResponse,
    DocumentInfo,
    PagePayload,
)
from .runtime import get_runtime

logger = get_logger("shawwn.documents")


class DocumentService:
    def __init__(self):
        self.runtime = get_runtime()

    async def check(self, url: str, chash: str) -> Optional[Document]:
        """Find an existing document with the same content hash.

        Prefers a match whose URL also matches (same page, same content); falls
        back to a hash-only match (same content served under a different URL).
        """
        norm = normalize_url(url)
        factory = get_session_factory()
        async with factory() as session:
            docs = (
                await session.execute(
                    select(Document).where(Document.content_hash == chash)
                )
            ).scalars().all()
            if not docs:
                return None
            for doc in docs:
                if normalize_url(doc.canonical_url) == norm or normalize_url(doc.url) == norm:
                    return doc
            return docs[0]

    async def index(self, payload: PagePayload) -> DocumentIndexResponse:
        settings = self.runtime.settings
        # Identity (content hash + document id) is computed over the ORIGINAL
        # payload so the extension and the /documents/check endpoint can compute
        # the same hash. Cleaning only affects chunking, not identity.
        chash = content_hash(payload)
        url = payload.page.url or payload.page.canonicalUrl

        existing = await self.check(url, chash)
        if existing and existing.status == "indexed":
            # Guard against a stale "indexed" status: if the vector store no
            # longer holds this document's chunks (e.g. an ephemeral in-memory
            # store was restarted), fall through and re-index instead of
            # returning an unusable document.
            store = self.runtime.vector_store()
            try:
                has_chunks = len(store.get_document_chunks(existing.id)) > 0
            except Exception:  # pragma: no cover - defensive
                has_chunks = False
            if has_chunks:
                logger.info("Document already indexed (reused): %s", existing.id)
                return DocumentIndexResponse(
                    document_id=existing.id,
                    status=existing.status,
                    chunk_count=existing.chunk_count,
                    reused=True,
                )
            logger.info(
                "Document marked indexed but vector store is empty; re-indexing %s",
                existing.id,
            )

        logger.info("Indexing document for url_len=%d", len(url))
        meta, chunks = process_document(
            payload,
            chunk_size=settings.chunk_size,
            chunk_overlap=settings.chunk_overlap,
        )
        document_id = meta["document_id"]

        await self._upsert_document(meta, status="processing", chunk_count=0)

        try:
            # Replace any obsolete chunks for this document id first.
            store = self.runtime.vector_store()
            store.ensure_collection()
            store.delete_document(document_id)

            with timed(logger, "embedding"):
                texts = [c.text for c in chunks]
                vectors = self.runtime.embedder().embed_documents(texts)

            payloads = []
            for chunk in chunks:
                p = chunk.to_payload()
                p["title"] = meta["title"]
                p["url"] = meta["url"]
                p["domain"] = meta["domain"]
                payloads.append(p)

            store.upsert(vectors, payloads)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Indexing failed: %s", exc)
            await self._upsert_document(meta, status="failed", chunk_count=0)
            raise

        await self._upsert_document(meta, status="indexed", chunk_count=len(chunks))
        logger.info("Indexed document %s with %d chunks", document_id, len(chunks))
        return DocumentIndexResponse(
            document_id=document_id, status="indexed", chunk_count=len(chunks)
        )

    async def get(self, document_id: str) -> DocumentInfo:
        doc = await self._get_row(document_id)
        if not doc:
            raise DocumentNotFound("The requested document was not found.")
        return self._to_info(doc)

    async def delete(self, document_id: str) -> None:
        doc = await self._get_row(document_id)
        if not doc:
            raise DocumentNotFound("The requested document was not found.")
        self.runtime.vector_store().delete_document(document_id)
        factory = get_session_factory()
        async with factory() as session:
            obj = await session.get(Document, document_id)
            if obj:
                await session.delete(obj)
                await session.commit()

    # ---- helpers -------------------------------------------------------- #
    async def _get_row(self, document_id: str) -> Optional[Document]:
        factory = get_session_factory()
        async with factory() as session:
            return await session.get(Document, document_id)

    async def _upsert_document(self, meta: dict, *, status: str, chunk_count: int) -> None:
        factory = get_session_factory()
        async with factory() as session:
            obj = await session.get(Document, meta["document_id"])
            if obj is None:
                obj = Document(id=meta["document_id"])
                session.add(obj)
            obj.url = meta["url"]
            obj.canonical_url = meta["canonical_url"]
            obj.title = meta["title"]
            obj.domain = meta["domain"]
            obj.content_hash = meta["content_hash"]
            obj.language = meta["language"]
            obj.status = status
            if chunk_count:
                obj.chunk_count = chunk_count
            await session.commit()

    @staticmethod
    def _to_info(doc: Document) -> DocumentInfo:
        return DocumentInfo(
            document_id=doc.id,
            url=doc.url,
            canonical_url=doc.canonical_url,
            title=doc.title,
            domain=doc.domain,
            content_hash=doc.content_hash,
            language=doc.language,
            status=doc.status,
            chunk_count=doc.chunk_count,
            created_at=iso(doc.created_at),
            updated_at=iso(doc.updated_at),
        )

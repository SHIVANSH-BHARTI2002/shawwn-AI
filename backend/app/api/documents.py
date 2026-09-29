"""Document ingestion and lifecycle endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..models.schemas import (
    DocumentCheckResponse,
    DocumentIndexResponse,
    DocumentInfo,
    PagePayload,
)
from ..services.document_service import DocumentService

router = APIRouter(tags=["documents"])


@router.post("/documents", response_model=DocumentIndexResponse)
async def create_document(payload: PagePayload) -> DocumentIndexResponse:
    return await DocumentService().index(payload)


@router.get("/documents/check", response_model=DocumentCheckResponse)
async def check_document(
    url: str = Query(...), content_hash: str = Query(...)
) -> DocumentCheckResponse:
    doc = await DocumentService().check(url, content_hash)
    if doc:
        return DocumentCheckResponse(
            exists=True, document_id=doc.id, status=doc.status
        )
    return DocumentCheckResponse(exists=False)


@router.get("/documents/{document_id}", response_model=DocumentInfo)
async def get_document(document_id: str) -> DocumentInfo:
    return await DocumentService().get(document_id)


@router.delete("/documents/{document_id}")
async def delete_document(document_id: str) -> dict:
    await DocumentService().delete(document_id)
    return {"status": "deleted", "document_id": document_id}

"""Search endpoint (retrieval inspection / debugging)."""

from __future__ import annotations

from fastapi import APIRouter

from ..models.schemas import SearchRequest, SearchResponse
from ..services.chat_service import ChatService

router = APIRouter(tags=["search"])


@router.post("/search", response_model=SearchResponse)
async def search(request: SearchRequest) -> SearchResponse:
    return await ChatService().search(
        document_id=request.document_id,
        query=request.query,
        top_k=request.top_k,
    )

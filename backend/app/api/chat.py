"""Chat endpoint."""

from __future__ import annotations

from fastapi import APIRouter

from ..models.schemas import ChatRequest, ChatResponse
from ..services.chat_service import ChatService

router = APIRouter(tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    return await ChatService().chat(
        document_id=request.document_id,
        message=request.message,
        conversation_id=request.conversation_id,
        attachments=request.attachments,
    )

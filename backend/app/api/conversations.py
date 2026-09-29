"""Conversation history endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from ..models.schemas import ConversationOut
from ..services.chat_service import ChatService

router = APIRouter(tags=["conversations"])


@router.get("/conversations/{conversation_id}", response_model=ConversationOut)
async def get_conversation(conversation_id: str) -> ConversationOut:
    return await ChatService().get_conversation(conversation_id)


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str) -> dict:
    await ChatService().delete_conversation(conversation_id)
    return {"status": "deleted", "conversation_id": conversation_id}

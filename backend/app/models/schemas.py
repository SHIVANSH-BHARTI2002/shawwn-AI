"""Pydantic schemas: the API contract.

These mirror the PageContext extension's extraction payload on input and define
the document/chat/citation response shapes on output.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Incoming page payload (from the extension)
# --------------------------------------------------------------------------- #
class PageInfo(BaseModel):
    title: str = ""
    url: str = ""
    domain: str = ""
    language: str = ""
    description: str = ""
    canonicalUrl: str = ""
    author: str = ""
    publishedDate: str = ""


class PageContent(BaseModel):
    markdown: str = ""
    text: str = ""
    wordCount: int = 0
    characterCount: int = 0


class TableStruct(BaseModel):
    headers: List[str] = Field(default_factory=list)
    rows: List[List[str]] = Field(default_factory=list)
    markdown: str = ""


class ListStruct(BaseModel):
    ordered: bool = False
    items: List[str] = Field(default_factory=list)


class HeadingStruct(BaseModel):
    level: int = 1
    text: str = ""


class LinkStruct(BaseModel):
    text: str = ""
    url: str = ""


class ImageStruct(BaseModel):
    alt: str = ""
    src: str = ""
    title: str = ""


class PageStructure(BaseModel):
    headings: List[HeadingStruct] = Field(default_factory=list)
    paragraphs: List[str] = Field(default_factory=list)
    lists: List[ListStruct] = Field(default_factory=list)
    tables: List[TableStruct] = Field(default_factory=list)
    links: List[LinkStruct] = Field(default_factory=list)
    images: List[ImageStruct] = Field(default_factory=list)


class PagePayload(BaseModel):
    """The full extraction payload emitted by the PageContext extension."""

    page: PageInfo
    content: PageContent
    structure: PageStructure = Field(default_factory=PageStructure)
    metadata: Dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Document API
# --------------------------------------------------------------------------- #
class DocumentIndexResponse(BaseModel):
    document_id: str
    status: str
    chunk_count: int
    reused: bool = False


class DocumentInfo(BaseModel):
    document_id: str
    url: str
    canonical_url: str
    title: str
    domain: str
    content_hash: str
    language: str
    status: str
    chunk_count: int
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class DocumentCheckResponse(BaseModel):
    exists: bool
    document_id: Optional[str] = None
    status: Optional[str] = None


# --------------------------------------------------------------------------- #
# Chat API
# --------------------------------------------------------------------------- #
class AttachmentIn(BaseModel):
    """A user-uploaded file (base64) accompanying a chat message."""

    name: str = ""
    mime_type: str
    data_b64: str = Field(min_length=1)


class ChatRequest(BaseModel):
    document_id: str
    message: str = Field(min_length=1)
    conversation_id: Optional[str] = None
    attachments: List[AttachmentIn] = Field(default_factory=list)


class Citation(BaseModel):
    chunk_id: str
    document_id: str
    title: str = ""
    url: str = ""
    section: str = ""
    heading_path: List[str] = Field(default_factory=list)
    text: str = ""
    score: float = 0.0


class RetrievalMeta(BaseModel):
    dense_results: int = 0
    bm25_results: int = 0
    hybrid_candidates: int = 0
    reranked_results: int = 0
    top_score: float = 0.0


class ChatResponse(BaseModel):
    answer: str
    citations: List[Citation] = Field(default_factory=list)
    retrieval: RetrievalMeta = Field(default_factory=RetrievalMeta)
    conversation_id: str
    grounded: bool = True


# --------------------------------------------------------------------------- #
# Search API (debug/inspection)
# --------------------------------------------------------------------------- #
class SearchRequest(BaseModel):
    document_id: str
    query: str = Field(min_length=1)
    top_k: int = 5


class SearchResultItem(BaseModel):
    chunk_id: str
    text: str
    section: str = ""
    heading_path: List[str] = Field(default_factory=list)
    score: float = 0.0


class SearchResponse(BaseModel):
    results: List[SearchResultItem] = Field(default_factory=list)
    retrieval: RetrievalMeta = Field(default_factory=RetrievalMeta)


# --------------------------------------------------------------------------- #
# Conversations
# --------------------------------------------------------------------------- #
class MessageOut(BaseModel):
    message_id: str
    role: str
    content: str
    citations: List[Citation] = Field(default_factory=list)
    created_at: Optional[str] = None


class ConversationOut(BaseModel):
    conversation_id: str
    document_id: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    messages: List[MessageOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Errors / health
# --------------------------------------------------------------------------- #
class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


class HealthResponse(BaseModel):
    status: str
    version: str
    mode: str
    services: Dict[str, str]

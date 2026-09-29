"""LLM provider abstraction.

The rest of the app depends on `LLMProvider`, never on a concrete SDK. This
lets us add Anthropic/Gemini/local providers without touching the RAG pipeline.

Messages may optionally carry multimodal `attachments` (images / PDFs) which
capable providers (e.g. Gemini) forward to the model. Providers that cannot
handle attachments simply ignore them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Attachment:
    """A user-uploaded file to include in the prompt.

    `data_b64` is the base64-encoded file content; `mime_type` e.g.
    "image/png" or "application/pdf".
    """

    mime_type: str
    data_b64: str
    name: str = ""


@dataclass
class LLMMessage:
    role: str  # "system" | "user" | "assistant"
    content: str
    attachments: List[Attachment] = field(default_factory=list)


class LLMProvider:
    name: str = "base"
    #: Whether this provider can consume image/PDF attachments.
    supports_attachments: bool = False

    async def generate(
        self,
        system_prompt: str,
        messages: List[LLMMessage],
        temperature: float = 0.0,
    ) -> str:
        raise NotImplementedError

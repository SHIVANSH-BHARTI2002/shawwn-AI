"""Agent state — future extension point.

For the current milestone only the RAG tool is implemented. This module defines
the state shape a future multi-tool agent (LangGraph or custom) would carry, so
adding browser/search tools later does not require reworking the core.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from ..models.schemas import Citation


@dataclass
class AgentState:
    document_id: str
    question: str
    conversation_id: Optional[str] = None
    rewritten_query: Optional[str] = None
    retrieved: List[dict] = field(default_factory=list)
    citations: List[Citation] = field(default_factory=list)
    answer: str = ""
    grounded: bool = True

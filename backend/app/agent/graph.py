"""Agent tool registry — future extension point.

The current milestone implements ONLY the RAG tool. Browser and web-search tools
are registered as disabled placeholders so the surface exists without adding
browser-automation dependencies now. A future LangGraph/agent orchestrator can
consume this registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, Optional


@dataclass
class Tool:
    name: str
    description: str
    handler: Optional[Callable] = None
    enabled: bool = False


def default_tool_registry() -> Dict[str, Tool]:
    return {
        "rag_search": Tool(
            "rag_search",
            "Retrieve relevant chunks from the current document.",
            enabled=True,
        ),
        "page_search": Tool("page_search", "Search within the live page DOM.", enabled=False),
        "scroll_page": Tool("scroll_page", "Scroll the active page.", enabled=False),
        "click_element": Tool("click_element", "Click a DOM element.", enabled=False),
        "web_search": Tool("web_search", "Search the public web.", enabled=False),
    }

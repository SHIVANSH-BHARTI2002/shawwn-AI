"""Test configuration.

Forces deterministic light mode and an isolated on-disk SQLite database before
any application module reads settings, so the full suite runs offline with no
heavy models or external services.
"""

import os
import tempfile

# Must be set before importing app modules (settings are cached).
os.environ["SHAWWN_LIGHT_MODE"] = "true"
os.environ["APP_ENV"] = "development"
os.environ["RATE_LIMIT_ENABLED"] = "false"
# Tests must be hermetic and deterministic: force the offline extractive
# provider by clearing any hosted-LLM keys that a local .env might supply.
os.environ["GEMINI_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["MISTRAL_API_KEY"] = ""
os.environ["LLM_PROVIDER"] = "none"

_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.close(_db_fd)
os.environ["POSTGRES_URL"] = f"sqlite+aiosqlite:///{_db_path}"

import pytest  # noqa: E402


@pytest.fixture
def laptop_payload():
    """A small, deterministic document used by RAG tests."""
    markdown = (
        "# Laptop\n\n"
        "## Processor\n\n"
        "Intel Core Ultra 7 155H\n\n"
        "## RAM\n\n"
        "16GB DDR5\n\n"
        "## Storage\n\n"
        "1TB SSD\n\n"
        "## Battery\n\n"
        "70Wh\n\n"
        "## Comparison\n\n"
        "| Model | RAM | Storage | Price |\n"
        "| --- | --- | --- | --- |\n"
        "| Model A | 8GB | 512GB | 50000 |\n"
        "| Model B | 16GB | 1TB | 70000 |\n"
    )
    text = (
        "Laptop Processor Intel Core Ultra 7 155H RAM 16GB DDR5 Storage 1TB SSD "
        "Battery 70Wh"
    )
    return {
        "page": {
            "title": "Laptop",
            "url": "https://example.com/laptop",
            "domain": "example.com",
            "language": "en",
            "description": "A test laptop page",
            "canonicalUrl": "https://example.com/laptop",
        },
        "content": {
            "markdown": markdown,
            "text": text,
            "wordCount": 40,
            "characterCount": len(text),
        },
        "structure": {
            "headings": [
                {"level": 1, "text": "Laptop"},
                {"level": 2, "text": "Processor"},
                {"level": 2, "text": "RAM"},
            ],
            "paragraphs": [],
            "lists": [],
            "tables": [
                {
                    "headers": ["Model", "RAM", "Storage", "Price"],
                    "rows": [
                        ["Model A", "8GB", "512GB", "50000"],
                        ["Model B", "16GB", "1TB", "70000"],
                    ],
                    "markdown": "",
                }
            ],
            "links": [],
            "images": [],
        },
        "metadata": {"extractedAt": "2026-01-01T00:00:00Z"},
    }

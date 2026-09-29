"""Google Gemini provider (full mode, multimodal).

Uses the Generative Language REST API directly via httpx, so no extra SDK is
required. Supports image/PDF attachments as inline data parts. The API key is
read from configuration and never leaves the server.
"""

from __future__ import annotations

from typing import List

import httpx

from ..core.logging import get_logger
from .base import LLMMessage, LLMProvider

logger = get_logger("shawwn.llm.gemini")

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiProvider(LLMProvider):
    name = "gemini"
    supports_attachments = True

    # Fallback models tried (in order) when the primary is unavailable (503/404).
    _FALLBACKS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-pro-latest"]

    def __init__(self, api_key: str, model: str = "gemini-flash-lite-latest", timeout: float = 30.0):
        self.api_key = api_key
        self.model = model or "gemini-flash-lite-latest"
        self.timeout = timeout

    def _contents(self, messages: List[LLMMessage]) -> list:
        """Map our messages to Gemini `contents`.

        Gemini roles are "user" and "model"; there is no system role in
        `contents` (the system prompt is sent via systemInstruction). Assistant
        turns map to "model".
        """
        contents = []
        for m in messages:
            if m.role == "system":
                continue
            role = "model" if m.role == "assistant" else "user"
            parts = []
            if m.content:
                parts.append({"text": m.content})
            for att in m.attachments or []:
                parts.append(
                    {
                        "inline_data": {
                            "mime_type": att.mime_type,
                            "data": att.data_b64,
                        }
                    }
                )
            if parts:
                contents.append({"role": role, "parts": parts})
        return contents

    async def generate(
        self,
        system_prompt: str,
        messages: List[LLMMessage],
        temperature: float = 0.4,
        *,
        max_retries: int = 2,
    ) -> str:
        import asyncio

        body = {
            "contents": self._contents(messages),
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "generationConfig": {
                "temperature": temperature,
                "topP": 0.95,
                "maxOutputTokens": 1024,
            },
        }
        headers = {
            "Content-Type": "application/json",
            "X-goog-api-key": self.api_key,
        }

        # Try the configured model first, then fall back to alternates that are
        # known-good with `-latest` aliases. Handles Google-side overload (503)
        # and per-key model availability (404).
        model_order = [self.model] + [m for m in self._FALLBACKS if m != self.model]

        last_status = None
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for model in model_order:
                url = f"{_BASE}/{model}:generateContent"
                for attempt in range(max_retries):
                    try:
                        resp = await client.post(url, headers=headers, json=body)
                    except (httpx.TimeoutException, httpx.TransportError) as exc:
                        # Network hiccup / timeout: retry, then try next model.
                        logger.warning("Gemini network error (%s)", type(exc).__name__)
                        last_status = 503
                        if attempt < max_retries - 1:
                            await asyncio.sleep(1.0 * (attempt + 1))
                            continue
                        break
                    if resp.status_code == 200:
                        text = _extract_text(resp.json())
                        if text:
                            return text
                        break  # empty; try next model
                    last_status = resp.status_code
                    if resp.status_code in (429, 500, 503) and attempt < max_retries - 1:
                        await asyncio.sleep(1.0 * (attempt + 1))
                        continue
                    logger.warning("Gemini API error %s (model=%s)", resp.status_code, model)
                    break  # try next model

        if last_status == 503:
            return (
                "The AI service is a little busy right now. Please try that again "
                "in a few seconds."
            )
        return "Sorry, I ran into a problem reaching the AI service. Please try again."


def _extract_text(data: dict) -> str:
    candidates = data.get("candidates") or []
    if not candidates:
        return ""
    parts = (candidates[0].get("content") or {}).get("parts") or []
    texts = [p.get("text", "") for p in parts if isinstance(p, dict)]
    return "".join(texts).strip()

"""Mistral AI provider.

Uses Mistral's OpenAI-compatible chat completions REST API via httpx. Text-only
(image/PDF attachments are handled by a multimodal provider like Gemini when
configured). The API key is read from configuration and never leaves the server.
"""

from __future__ import annotations

from typing import List

import httpx

from ..core.logging import get_logger
from .base import LLMMessage, LLMProvider

logger = get_logger("shawwn.llm.mistral")

_URL = "https://api.mistral.ai/v1/chat/completions"


class MistralProvider(LLMProvider):
    name = "mistral"
    supports_attachments = False

    def __init__(self, api_key: str, model: str = "mistral-small-latest", timeout: float = 60.0):
        self.api_key = api_key
        self.model = model or "mistral-small-latest"
        self.timeout = timeout

    async def generate(
        self,
        system_prompt: str,
        messages: List[LLMMessage],
        temperature: float = 0.4,
        *,
        max_retries: int = 2,
    ) -> str:
        import asyncio

        payload = [{"role": "system", "content": system_prompt}]
        for m in messages:
            role = m.role if m.role in ("user", "assistant", "system") else "user"
            payload.append({"role": role, "content": m.content})

        body = {
            "model": self.model,
            "messages": payload,
            "temperature": temperature,
            "max_tokens": 1024,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for attempt in range(max_retries):
                try:
                    resp = await client.post(_URL, headers=headers, json=body)
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    logger.warning("Mistral network error (%s)", type(exc).__name__)
                    if attempt < max_retries - 1:
                        await asyncio.sleep(1.0 * (attempt + 1))
                        continue
                    break
                if resp.status_code == 200:
                    data = resp.json()
                    choices = data.get("choices") or []
                    if choices:
                        return (choices[0].get("message", {}).get("content") or "").strip()
                    return ""
                if resp.status_code in (429, 500, 502, 503) and attempt < max_retries - 1:
                    await asyncio.sleep(1.0 * (attempt + 1))
                    continue
                logger.warning("Mistral API error %s", resp.status_code)
                break

        return "Sorry, I ran into a problem reaching the AI service. Please try again."

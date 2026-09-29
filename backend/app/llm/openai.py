"""OpenAI LLM provider (full mode)."""

from __future__ import annotations

from typing import List

from .base import LLMMessage, LLMProvider


class OpenAIProvider(LLMProvider):  # pragma: no cover - requires network + key
    name = "openai"

    def __init__(self, api_key: str, model: str, base_url: str = ""):
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(
            api_key=api_key, base_url=base_url or None
        )
        self.model = model

    async def generate(
        self,
        system_prompt: str,
        messages: List[LLMMessage],
        temperature: float = 0.0,
    ) -> str:
        payload = [{"role": "system", "content": system_prompt}]
        payload += [{"role": m.role, "content": m.content} for m in messages]
        resp = await self._client.chat.completions.create(
            model=self.model,
            messages=payload,
            temperature=temperature,
        )
        return (resp.choices[0].message.content or "").strip()

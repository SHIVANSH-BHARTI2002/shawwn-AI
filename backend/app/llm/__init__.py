"""LLM provider factory.

Provider selection is independent of retrieval "light mode": a hosted LLM
(Gemini / Mistral / OpenAI) only needs an API key and network, so it can pair
with the lightweight retrieval stack. When no key is configured, the
deterministic extractive provider is used (offline, grounded, used by tests).

Multiple configured providers are chained: if the primary fails (e.g. Gemini
returns a transient "busy"/error message), the next provider is tried. This
keeps the chat responsive when one API is overloaded.
"""

from __future__ import annotations

from typing import List

from .base import Attachment, LLMMessage, LLMProvider

# Sentinel phrases a provider returns when it failed but didn't raise.
_FAILURE_MARKERS = ("problem reaching the ai service", "a little busy right now")


def _is_failure(text: str) -> bool:
    low = (text or "").lower()
    return not text.strip() or any(m in low for m in _FAILURE_MARKERS)


class FallbackProvider(LLMProvider):
    """Try each provider in order until one returns a usable answer."""

    def __init__(self, providers: List[LLMProvider]):
        self.providers = providers
        self.name = "+".join(p.name for p in providers) or "none"
        self.supports_attachments = any(
            getattr(p, "supports_attachments", False) for p in providers
        )

    async def generate(self, system_prompt, messages, temperature=0.4) -> str:
        last = ""
        for provider in self.providers:
            # Skip non-multimodal providers when the turn carries attachments
            # and a multimodal one exists later in the chain.
            has_files = any(getattr(m, "attachments", None) for m in messages)
            if has_files and not getattr(provider, "supports_attachments", False):
                if any(
                    getattr(p, "supports_attachments", False)
                    for p in self.providers
                    if p is not provider
                ):
                    continue
            try:
                out = await provider.generate(system_prompt, messages, temperature)
            except Exception:  # pragma: no cover - network errors
                out = ""
            if not _is_failure(out):
                return out
            last = out
        return last or "Sorry, I couldn't generate a response. Please try again."


def _build_single(name: str, settings):
    name = (name or "").lower()
    if name == "gemini" and settings.gemini_api_key:
        from .gemini import GeminiProvider

        return GeminiProvider(settings.gemini_api_key, settings.gemini_model)
    if name == "mistral" and settings.mistral_api_key:
        from .mistral import MistralProvider

        return MistralProvider(settings.mistral_api_key, settings.mistral_model)
    if name == "openai" and settings.openai_api_key:
        from .openai import OpenAIProvider

        return OpenAIProvider(
            settings.openai_api_key, settings.openai_model, settings.openai_base_url
        )
    return None


def build_llm(settings, light_mode: bool) -> LLMProvider:
    from ..core.logging import get_logger

    logger = get_logger("shawwn.llm")

    # Build the preferred provider first, then chain the rest as fallbacks.
    preferred = (settings.llm_provider or "").lower()
    order = [preferred] + [p for p in ("gemini", "mistral", "openai") if p != preferred]

    providers: List[LLMProvider] = []
    for name in order:
        try:
            provider = _build_single(name, settings)
        except Exception:  # pragma: no cover
            provider = None
            logger.warning("Provider %s unavailable.", name)
        if provider is not None:
            providers.append(provider)

    if providers:
        logger.info("LLM chain: %s", " -> ".join(p.name for p in providers))
        return FallbackProvider(providers) if len(providers) > 1 else providers[0]

    from .extractive import ExtractiveProvider

    return ExtractiveProvider()


__all__ = ["Attachment", "LLMMessage", "LLMProvider", "FallbackProvider", "build_llm"]

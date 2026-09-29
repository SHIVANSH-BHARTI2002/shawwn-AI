"""Deterministic extractive LLM provider for light mode / tests.

This is NOT a language model. It answers strictly from the provided context by
selecting the most query-relevant line/sentence, so behavior is fully
deterministic and grounded (no hallucination). It powers the offline test suite
and gives the extension a working answer path without an API key.

It also honors the injection-defense contract: because it only ever echoes
selected spans of the context (never "executes" it), embedded instructions in
the page cannot change its behavior.
"""

from __future__ import annotations

import re
from typing import List

from .base import LLMMessage, LLMProvider
from .prompts import NO_ANSWER_TEXT

_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = {
    "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
    "is", "are", "was", "were", "be", "been", "the", "a", "an", "of", "to",
    "in", "on", "for", "and", "or", "does", "do", "did", "this", "that",
    "it", "its", "with", "about", "page", "have", "has", "much", "many",
}


def _tokens(text: str) -> List[str]:
    return _TOKEN.findall(text.lower())


def _content_terms(question: str) -> set:
    return {t for t in _tokens(question) if t not in _STOP and len(t) > 1}


def _extract_context(user_content: str) -> str:
    m = re.search(r"<<<CONTEXT_START>>>\n(.*?)\n<<<CONTEXT_END>>>", user_content, re.S)
    return m.group(1) if m else user_content


def _extract_question(user_content: str) -> str:
    m = re.search(r"User question:\s*(.+)", user_content)
    return m.group(1).strip() if m else ""


class ExtractiveProvider(LLMProvider):
    name = "extractive"

    async def generate(
        self,
        system_prompt: str,
        messages: List[LLMMessage],
        temperature: float = 0.0,
    ) -> str:
        last_user = next(
            (m.content for m in reversed(messages) if m.role == "user"), ""
        )
        context = _extract_context(last_user)
        question = _extract_question(last_user)

        # Summary request handling.
        if "Summarize" in last_user and "User question" not in last_user:
            return self._summarize(context)

        q_terms = _content_terms(question)
        if not q_terms:
            return NO_ANSWER_TEXT

        # Each candidate is (answer_text, match_terms) where match_terms include
        # the section/breadcrumb context so a question like "what is the
        # processor?" can match the "Processor" section even when the answer
        # value itself ("Intel Core Ultra 7 155H") shares no words with it.
        candidates = self._candidate_lines(context)
        best_line, best_score = None, 0.0
        for answer_text, match_terms in candidates:
            if not match_terms:
                continue
            overlap = len(q_terms & match_terms)
            if overlap == 0:
                continue
            score = overlap / len(q_terms)
            if score > best_score:
                best_score, best_line = score, answer_text

        if not best_line or best_score <= 0:
            return NO_ANSWER_TEXT
        return best_line.strip()

    @staticmethod
    def _candidate_lines(context: str):
        """Return list of (answer_text, match_terms).

        match_terms carry the current section context (from `Section:` headers
        and `[breadcrumb]` lines) so answers inherit their heading keywords.
        """
        candidates = []
        section_terms: set = set()
        raw_lines = context.split("\n")
        lines = [ln.strip() for ln in raw_lines]

        def is_separator(s: str) -> bool:
            return bool(re.fullmatch(r"\|?[\s|:-]+\|?", s)) and "|" in s

        for i, line in enumerate(lines):
            if not line:
                continue
            if re.match(r"^(Source \d+:|Title:|URL:|Content:)", line):
                continue
            if line == "---":
                section_terms = set()
                continue
            m = re.match(r"^Section:\s*(.*)$", line)
            if m:
                section_terms = set(_tokens(m.group(1)))
                continue
            if re.fullmatch(r"\[[^\]]*\]", line):
                section_terms |= set(_tokens(line.strip("[]")))
                continue
            if is_separator(line):
                continue
            if line.startswith("|") and line.endswith("|"):
                # Skip the table header row (the one followed by a separator).
                if i + 1 < len(lines) and is_separator(lines[i + 1]):
                    continue
                cells = [c.strip() for c in line.strip("|").split("|")]
                cells = [c for c in cells if c]
                if len(cells) >= 2:
                    answer = f"{cells[0]}: {' '.join(cells[1:])}"
                    terms = set(_tokens(answer)) | section_terms
                    candidates.append((answer, terms))
                    continue
            for sent in re.split(r"(?<=[.!?])\s+", line):
                sent = sent.strip()
                if sent:
                    candidates.append((sent, set(_tokens(sent)) | section_terms))
        return candidates

    @staticmethod
    def _summarize(context: str) -> str:
        lines = [ln.strip() for ln in context.split("\n") if ln.strip()]
        # Keep headings/breadcrumbs and the first content line of each section.
        picked: List[str] = []
        for ln in lines:
            if re.fullmatch(r"\[[^\]]*\]", ln):
                picked.append(ln.strip("[]"))
            elif ln and not ln.startswith("|"):
                picked.append(ln)
            if len(picked) >= 12:
                break
        summary = " ".join(picked[:12])
        return summary[:800] if summary else NO_ANSWER_TEXT

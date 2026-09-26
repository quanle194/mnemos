"""Deterministic contradiction heuristics used by validation and dreaming.

An LLM judge may refine these signals, but the rule-based layer guarantees deterministic behaviour with fake
providers and acts as a safety net when a real provider is unavailable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.domain.text import STOPWORDS, content_tokens, normalize

_NEGATION = re.compile(
    r"(?i)\b(not|never|no longer|don't|do not|doesn't|does not|avoid|without|stop|disable[ds]?|forbid(?:den)?|"
    r"deprecated|mustn't|must not|shouldn't|should not|cannot|can't|won't|isn't|aren't|fails?)\b"
)
_INSTEAD = re.compile(r"(?i)\b(?:use|prefer|choose|run)\s+([\w.\-/]+)\s+(?:instead of|rather than|over)\s+([\w.\-/]+)")
_NUM = re.compile(r"\b\d+(?:\.\d+)?[a-z%]*\b")
_SUPERSEDE_HINT = re.compile(
    r"(?i)\b(no longer|deprecated|now (?:use|uses|requires)|as of|changed to|replaced by|"
    r"superseded|outdated)\b"
)


@dataclass(frozen=True)
class ContradictionSignal:
    contradicts: bool
    kind: str | None
    topical_overlap: float
    supersede_hint: bool
    explanation: str


def _overlap(a: str, b: str) -> float:
    sa = {t for t in content_tokens(a) if not _NUM.fullmatch(t)}
    sb = {t for t in content_tokens(b) if not _NUM.fullmatch(t)}
    sa -= _NEG_TOKENS
    sb -= _NEG_TOKENS
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / min(len(sa), len(sb))


_NEG_TOKENS = (
    frozenset(
        {
            "not",
            "never",
            "don't",
            "doesn't",
            "avoid",
            "without",
            "stop",
            "disable",
            "disabled",
            "forbid",
            "forbidden",
            "deprecated",
            "mustn't",
            "shouldn't",
            "cannot",
            "can't",
            "won't",
            "longer",
            "fail",
            "fails",
        }
    )
    | STOPWORDS
)


def has_negation(text: str) -> bool:
    return bool(_NEGATION.search(text))


def detect(existing: str, candidate: str, *, min_overlap: float = 0.5) -> ContradictionSignal:
    a, b = normalize(existing), normalize(candidate)
    overlap = _overlap(a, b)
    hint = bool(_SUPERSEDE_HINT.search(b))
    if overlap < min_overlap:
        return ContradictionSignal(False, None, overlap, hint, "insufficient topical overlap")

    ia, ib = _INSTEAD.search(a), _INSTEAD.search(b)
    if ia and ib:
        xa, ya = ia.group(1).lower(), ia.group(2).lower()
        xb, yb = ib.group(1).lower(), ib.group(2).lower()
        if xa == yb and ya == xb:
            return ContradictionSignal(
                True, "preference_swap", overlap, hint, f"'{xa} instead of {ya}' vs '{xb} instead of {yb}'"
            )

    if has_negation(a) != has_negation(b):
        return ContradictionSignal(True, "polarity", overlap, hint, "same topic with opposite polarity")

    nums_a, nums_b = set(_NUM.findall(a)), set(_NUM.findall(b))
    if nums_a and nums_b and nums_a != nums_b and overlap >= max(min_overlap, 0.7):
        return ContradictionSignal(
            True, "value_mismatch", overlap, hint, f"different values {sorted(nums_a)} vs {sorted(nums_b)}"
        )
    return ContradictionSignal(False, None, overlap, hint, "compatible")

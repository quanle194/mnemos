"""Text normalisation helpers."""

from __future__ import annotations

import hashlib
import re
import unicodedata

_WS = re.compile(r"\s+")
_TOKEN = re.compile(r"[a-z0-9][a-z0-9_\-./]*")
STOPWORDS = frozenset(
    [
        "a",
        "an",
        "the",
        "and",
        "or",
        "but",
        "if",
        "then",
        "else",
        "of",
        "to",
        "in",
        "on",
        "at",
        "for",
        "with",
        "by",
        "from",
        "as",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "it",
        "this",
        "that",
        "these",
        "those",
        "i",
        "we",
        "you",
        "they",
        "he",
        "she",
        "them",
        "our",
        "your",
        "their",
        "its",
        "do",
        "does",
        "did",
        "so",
        "than",
        "too",
        "very",
        "can",
        "could",
        "should",
        "would",
        "will",
        "just",
        "into",
        "over",
        "under",
        "about",
        "after",
        "before",
        "when",
        "while",
        "which",
        "who",
        "whom",
        "what",
        "where",
        "why",
        "how",
    ]
)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower().strip()
    return _WS.sub(" ", text)


def content_hash(text: str) -> str:
    norm = re.sub(r"[^a-z0-9 ]", "", normalize(text))
    return hashlib.sha256(norm.encode()).hexdigest()


def tokens(text: str) -> list[str]:
    return [t.strip("-./") for t in _TOKEN.findall(normalize(text)) if t.strip("-./")]


def content_tokens(text: str) -> list[str]:
    return [t for t in tokens(text) if t not in STOPWORDS and len(t) > 1]


def jaccard(a: str, b: str) -> float:
    sa, sb = set(content_tokens(a)), set(content_tokens(b))
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"

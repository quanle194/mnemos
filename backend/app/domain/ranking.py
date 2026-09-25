"""Ranking math for hybrid retrieval. Pure functions, fully traceable."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

SEMANTIC_WEIGHT = 0.65
LEXICAL_WEIGHT = 0.35

SCOPE_BONUS: dict[str, float] = {
    "session": 0.04,
    "agent": 0.03,
    "project": 0.02,
    "workspace": 0.01,
    "organization": 0.0,
}


@dataclass
class RankInput:
    semantic: float  # cosine similarity in [-1, 1]
    lexical: float  # raw ts_rank_cd (>= 0)
    importance: float
    trust: float
    confidence: float
    utility: float
    updated_at: datetime
    scope_type: str


@dataclass
class ScoreBreakdown:
    semantic: float
    lexical: float
    relevance: float
    importance: float
    trust: float
    recency: float
    utility: float
    scope_bonus: float
    total: float
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, float]:
        return {
            "semantic": self.semantic,
            "lexical": self.lexical,
            "relevance": self.relevance,
            "importance": self.importance,
            "trust": self.trust,
            "recency": self.recency,
            "utility": self.utility,
            "scope_bonus": self.scope_bonus,
            "total": self.total,
        }


def clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def normalize_lexical(raw: float, max_raw: float) -> float:
    if max_raw <= 0 or raw <= 0:
        return 0.0
    return clamp01(raw / max_raw)


def recency_score(updated_at: datetime, now: datetime, half_life_days: float) -> float:
    age_days = max(0.0, (now - updated_at).total_seconds() / 86400)
    if half_life_days <= 0:
        return 1.0
    return math.exp(-age_days / half_life_days * math.log(2))


def score(item: RankInput, *, lexical_norm: float, now: datetime, weights: dict[str, float],
          half_life_days: float) -> ScoreBreakdown:
    semantic = clamp01(item.semantic)
    relevance = SEMANTIC_WEIGHT * semantic + LEXICAL_WEIGHT * lexical_norm
    trust = clamp01(item.trust) * clamp01(item.confidence)
    recency = recency_score(item.updated_at, now, half_life_days)
    bonus = SCOPE_BONUS.get(item.scope_type, 0.0)
    total = (
        weights["relevance"] * relevance
        + weights["importance"] * clamp01(item.importance)
        + weights["trust"] * trust
        + weights["recency"] * recency
        + weights["utility"] * clamp01(item.utility)
        + bonus
    )
    reasons: list[str] = []
    if semantic >= 0.5:
        reasons.append(f"semantic match {semantic:.2f}")
    if lexical_norm > 0:
        reasons.append(f"keyword match {lexical_norm:.2f}")
    if item.importance >= 0.7:
        reasons.append("high importance")
    if trust >= 0.6:
        reasons.append("trusted source")
    if item.utility >= 0.6:
        reasons.append("proven helpful")
    if bonus > 0:
        reasons.append(f"{item.scope_type}-scoped")
    return ScoreBreakdown(
        semantic=round(semantic, 4),
        lexical=round(lexical_norm, 4),
        relevance=round(relevance, 4),
        importance=round(item.importance, 4),
        trust=round(trust, 4),
        recency=round(recency, 4),
        utility=round(item.utility, 4),
        scope_bonus=bonus,
        total=round(total, 6),
        reasons=reasons,
    )


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)

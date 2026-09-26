"""Structured-output schemas for every LLM task. LLM output is always validated against these."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.domain.enums import MemoryType

LLMTask = Literal[
    "memory_extraction",
    "episode_summary",
    "reflection",
    "pattern_summary",
    "consolidation",
    "generalization",
    "contradiction_judgment",
]


class CandidateOut(BaseModel):
    type: MemoryType
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=4000)
    confidence: float = Field(ge=0, le=1)
    importance: float = Field(ge=0, le=1, default=0.5)
    evidence_ids: list[str] = Field(default_factory=list)
    rationale: str = ""


class ExtractionOut(BaseModel):
    candidates: list[CandidateOut] = Field(default_factory=list, max_length=10)


class EpisodeSummaryOut(BaseModel):
    summary: str = Field(min_length=1, max_length=4000)
    outcome: Literal["success", "failure", "partial", "unknown"]
    importance: float = Field(ge=0, le=1)


class ReflectionOut(BaseModel):
    lessons: list[CandidateOut] = Field(default_factory=list, max_length=20)


class SynthesisOut(BaseModel):
    """Used by pattern_summary, consolidation and generalization."""

    type: MemoryType
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=4000)
    confidence: float = Field(ge=0, le=1)


class ContradictionOut(BaseModel):
    relation: Literal["contradicts", "supersedes", "duplicate", "supports", "unrelated"]
    confidence: float = Field(ge=0, le=1)
    explanation: str = ""


TASK_SCHEMAS: dict[str, type[BaseModel]] = {
    "memory_extraction": ExtractionOut,
    "episode_summary": EpisodeSummaryOut,
    "reflection": ReflectionOut,
    "pattern_summary": SynthesisOut,
    "consolidation": SynthesisOut,
    "generalization": SynthesisOut,
    "contradiction_judgment": ContradictionOut,
}

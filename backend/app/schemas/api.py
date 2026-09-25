"""Request/response models for the public REST API."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.enums import (
    ConflictResolution,
    DreamMode,
    EventType,
    EvidenceSourceType,
    ExperienceSource,
    FeedbackValue,
    MemoryStatus,
    MemoryType,
    Outcome,
    RelationType,
    Role,
    ScopeType,
)
from app.schemas.common import ORM


class RefsIn(BaseModel):
    workspace_id: uuid.UUID
    project_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    project_name: str | None = Field(default=None, max_length=200)
    agent_name: str | None = Field(default=None, max_length=200)


# ------------------------------------------------------------------ admin / keys / workspaces
class BootstrapIn(BaseModel):
    organization_name: str = Field(min_length=1, max_length=200)
    workspace_name: str = Field(default="default", min_length=1, max_length=200)


class BootstrapOut(BaseModel):
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    api_key: str
    api_key_id: uuid.UUID


class ApiKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    role: Role
    workspace_ids: list[uuid.UUID] | None = None


class ApiKeyOut(ORM):
    id: uuid.UUID
    name: str
    prefix: str
    role: str
    workspace_ids: list[uuid.UUID] | None
    created_at: datetime
    revoked_at: datetime | None
    last_used_at: datetime | None


class ApiKeyCreated(ApiKeyOut):
    api_key: str


class MeOut(BaseModel):
    organization_id: uuid.UUID
    role: str
    actor_id: str
    permissions: list[str]
    workspace_ids: list[uuid.UUID] | None


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    settings_json: dict[str, Any] = Field(default_factory=dict)


class NamedIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="agent", max_length=50)
    metadata: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------------ events / working memory
class EventItem(BaseModel):
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)
    task_id: str | None = Field(default=None, max_length=200)
    occurred_at: datetime | None = None


class EventsIn(RefsIn):
    events: list[EventItem] = Field(min_length=1, max_length=500)


class EventOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    session_id: uuid.UUID | None
    task_id: str | None
    type: str
    payload_json: dict[str, Any]
    occurred_at: datetime
    created_at: datetime


class WorkingMemoryIn(BaseModel):
    workspace_id: uuid.UUID
    agent_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    key: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20000)
    ttl_seconds: int = Field(default=3600, ge=1, le=60 * 60 * 24 * 30)
    importance: float = Field(default=0.5, ge=0, le=1)


class WorkingMemoryOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    agent_id: uuid.UUID | None
    session_id: uuid.UUID | None
    key: str
    content: str
    importance: float
    expires_at: datetime
    updated_at: datetime


# ------------------------------------------------------------------ experiences / episodes
class ExperienceIn(RefsIn):
    task_id: str | None = Field(default=None, max_length=200)
    task: str = Field(min_length=1, max_length=20000)
    observation: str = Field(default="", max_length=20000)
    action: str = Field(default="", max_length=20000)
    result: str = Field(default="", max_length=20000)
    outcome: Outcome
    importance: float = Field(default=0.5, ge=0, le=1)
    confidence: float = Field(default=0.7, ge=0, le=1)
    source: ExperienceSource = ExperienceSource.AGENT
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExperienceOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    session_id: uuid.UUID | None
    task_id: str | None
    episode_id: uuid.UUID | None
    task: str
    observation: str
    action: str
    result: str
    outcome: str
    importance: float
    confidence: float
    source: str
    source_trust: float
    metadata_json: dict[str, Any]
    processing_status: str
    processed_at: datetime | None
    created_at: datetime


class LearningStatus(BaseModel):
    job_id: str | None
    job_status: str | None
    processing_status: str
    memories: list[dict[str, Any]]


class ExperienceCreated(BaseModel):
    experience: ExperienceOut
    learning: LearningStatus


class ExperienceDetail(ExperienceOut):
    learning: LearningStatus | None = None


class EpisodeOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    session_id: uuid.UUID | None
    task_id: str | None
    summary: str
    outcome: str
    importance: float
    confidence: float
    experience_count: int
    started_at: datetime
    completed_at: datetime | None
    updated_at: datetime


class EpisodeDetail(EpisodeOut):
    experiences: list[ExperienceOut]


# ------------------------------------------------------------------ memories
class EvidenceIn(BaseModel):
    source_type: EvidenceSourceType
    source_id: str = Field(min_length=1, max_length=100)
    relation: Literal["supports", "derived_from", "contradicts"] = "supports"
    weight: float = Field(default=1.0, ge=0, le=10)
    excerpt: str = Field(default="", max_length=1000)


class MemoryIn(RefsIn):
    type: MemoryType
    scope_type: ScopeType = ScopeType.PROJECT
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=20000)
    confidence: float = Field(default=0.6, ge=0, le=1)
    importance: float = Field(default=0.5, ge=0, le=1)
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    status: Literal["candidate", "active"] = "candidate"
    layer: Literal[3, 4] = 3
    evidence: list[EvidenceIn] = Field(default_factory=list, max_length=50)
    metadata: dict[str, Any] = Field(default_factory=dict)


class MemoryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    content: str | None = Field(default=None, min_length=1, max_length=20000)
    type: MemoryType | None = None
    importance: float | None = Field(default=None, ge=0, le=1)
    confidence: float | None = Field(default=None, ge=0, le=1)
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    status: MemoryStatus | None = None
    metadata: dict[str, Any] | None = None
    reason: str = Field(default="manual edit", max_length=500)


class MemoryOut(ORM):
    id: uuid.UUID
    organization_id: uuid.UUID
    workspace_id: uuid.UUID | None
    project_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    layer: int
    type: str
    scope_type: str
    scope_id: uuid.UUID
    title: str
    content: str
    status: str
    review_state: str
    confidence: float
    trust_score: float
    importance: float
    utility_score: float
    valid_from: datetime
    valid_until: datetime | None
    version: int
    metadata_json: dict[str, Any]
    retrieval_count: int
    last_retrieved_at: datetime | None
    created_by_type: str
    created_by_id: str | None
    created_at: datetime
    updated_at: datetime


class ReviewIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=2000)
    expected_version: int | None = None


class PromoteIn(BaseModel):
    scope_type: Literal["workspace", "organization"] = "workspace"
    expected_version: int | None = None
    note: str = Field(default="", max_length=2000)


class RelationIn(BaseModel):
    target_memory_id: uuid.UUID
    relation: RelationType
    metadata: dict[str, Any] = Field(default_factory=dict)


class VersionOut(ORM):
    id: uuid.UUID
    version: int
    snapshot_json: dict[str, Any]
    change_reason: str
    actor_type: str
    actor_id: str | None
    created_at: datetime


class EvidenceOut(ORM):
    id: uuid.UUID
    source_type: str
    source_id: str
    relation: str
    weight: float
    excerpt: str
    created_at: datetime
    source: dict[str, Any] | None = None


class RelationOut(BaseModel):
    id: uuid.UUID
    relation: str
    direction: Literal["outgoing", "incoming"]
    other: dict[str, Any]
    metadata: dict[str, Any]
    created_at: datetime


class UsageOut(BaseModel):
    trace_id: uuid.UUID
    kind: str
    query: str
    rank: int
    score: float
    agent_id: uuid.UUID | None
    created_at: datetime


class FeedbackIn(BaseModel):
    value: FeedbackValue
    note: str = Field(default="", max_length=2000)
    agent_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    task_id: str | None = Field(default=None, max_length=200)
    retrieval_trace_id: uuid.UUID | None = None


class FeedbackOut(ORM):
    id: uuid.UUID
    memory_id: uuid.UUID
    value: str
    note: str
    agent_id: uuid.UUID | None
    task_id: str | None
    retrieval_trace_id: uuid.UUID | None
    created_at: datetime


class FeedbackResult(BaseModel):
    feedback: FeedbackOut
    memory: dict[str, Any]


# ------------------------------------------------------------------ retrieval
class SearchIn(RefsIn):
    query: str = Field(min_length=1, max_length=4000)
    types: list[MemoryType] | None = None
    statuses: list[MemoryStatus] | None = None
    layers: list[Literal[3, 4]] | None = None
    scope_mode: Literal["chain", "workspace"] | None = None
    valid_at: datetime | None = None
    limit: int = Field(default=10, ge=1, le=100)
    min_relevance: float = Field(default=0.0, ge=0, le=1)


class ScoredMemory(BaseModel):
    memory: MemoryOut
    score: float
    scores: dict[str, float]
    reasons: list[str]


class SearchOut(BaseModel):
    items: list[ScoredMemory]
    retrieval_trace_id: uuid.UUID
    weights: dict[str, float]


class ContextIn(RefsIn):
    query: str = Field(min_length=1, max_length=8000)
    token_budget: int = Field(default=2000, ge=50, le=200_000)
    memory_types: list[MemoryType] | None = None
    max_items: int = Field(default=10, ge=1, le=100)
    include_candidates: bool = False
    min_relevance: float = Field(default=0.2, ge=0, le=1)


class ContextMemory(BaseModel):
    id: uuid.UUID
    type: str
    title: str
    content: str
    scope_type: str
    status: str
    confidence: float
    trust_score: float
    importance: float
    utility_score: float
    version: int
    score: float
    scores: dict[str, float]
    reasons: list[str]
    tokens: int
    evidence: dict[str, int]


class ContextOut(BaseModel):
    context: str
    memories: list[ContextMemory]
    token_estimate: int
    token_budget: int
    token_estimate_method: str = "chars/4 heuristic"  # noqa: S105 - not a secret
    retrieval_trace_id: uuid.UUID
    candidate_count: int
    excluded: list[dict[str, Any]]


class TraceOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    kind: str
    query: str
    request_json: dict[str, Any]
    candidates_json: dict[str, Any]
    selected_json: dict[str, Any]
    context_tokens: int
    latency_ms: float
    agent_id: uuid.UUID | None
    created_at: datetime


# ------------------------------------------------------------------ conflicts / dreams / jobs / audit
class ConflictOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID | None
    candidate_memory_id: uuid.UUID
    existing_memory_id: uuid.UUID
    conflict_type: str
    status: str
    analysis_json: dict[str, Any]
    resolution_json: dict[str, Any]
    created_at: datetime
    resolved_at: datetime | None


class ConflictDetail(ConflictOut):
    candidate: MemoryOut | None = None
    existing: MemoryOut | None = None


class ResolveIn(BaseModel):
    resolution: ConflictResolution
    note: str = Field(default="", max_length=2000)


class DreamIn(BaseModel):
    workspace_id: uuid.UUID
    mode: DreamMode
    dedupe_window: bool = False


class DreamOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    mode: str
    status: str
    trigger_type: str
    window_hash: str | None
    input_window_json: dict[str, Any]
    result_json: dict[str, Any]
    checkpoint_json: dict[str, Any]
    error: str | None
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime


class JobOut(ORM):
    id: uuid.UUID
    kind: str
    status: str
    attempts: int
    max_attempts: int
    payload_json: dict[str, Any]
    last_error: str | None
    result_json: dict[str, Any]
    run_after: datetime
    created_at: datetime
    completed_at: datetime | None


class AuditOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID | None
    actor_type: str
    actor_id: str | None
    action: str
    resource_type: str
    resource_id: str | None
    before_json: dict[str, Any]
    after_json: dict[str, Any]
    request_id: str | None
    created_at: datetime


class EvalRunIn(BaseModel):
    workspace_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    summary: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] = Field(default_factory=dict)


class EvalRunOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID | None
    name: str
    status: str
    summary_json: dict[str, Any]
    result_json: dict[str, Any]
    created_at: datetime

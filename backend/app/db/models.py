"""SQLAlchemy ORM models. Every tenant-owned table carries organization_id."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    CheckConstraint,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.config import get_settings
from app.db.base import Base, new_id, utcnow
from app.domain import enums as E

DIM = get_settings().embedding_dimensions


def _enum_check(column: str, enum: type[StrEnum]) -> str:
    values = ", ".join(f"'{v.value}'" for v in enum)
    return f"{column} IN ({values})"


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=new_id)


def created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=text("now()"))


def org_fk() -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )


def ws_fk(nullable: bool = False) -> Mapped[Any]:
    return mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=nullable, index=True
    )


def jsonb() -> Mapped[dict[str, Any]]:
    return mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = created()


class Workspace(Base):
    __tablename__ = "workspaces"
    __table_args__ = (UniqueConstraint("organization_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    settings_json: Mapped[dict[str, Any]] = jsonb()
    created_at: Mapped[datetime] = created()


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("workspace_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = created()


class Agent(Base):
    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("workspace_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(50), nullable=False, default="agent")
    metadata_json: Mapped[dict[str, Any]] = jsonb()
    created_at: Mapped[datetime] = created()


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"))
    started_at: Mapped[datetime] = created()
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    metadata_json: Mapped[dict[str, Any]] = jsonb()


class ApiKey(Base):
    __tablename__ = "api_keys"
    __table_args__ = (CheckConstraint(_enum_check("role", E.Role), name="role"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    prefix: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    key_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    workspace_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(UUID(as_uuid=True)))
    created_at: Mapped[datetime] = created()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint(_enum_check("type", E.EventType), name="type"),
        Index("ix_events_ws_occurred", "workspace_id", "occurred_at"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    task_id: Mapped[str | None] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    payload_json: Mapped[dict[str, Any]] = jsonb()
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    created_at: Mapped[datetime] = created()


class WorkingMemory(Base):
    __tablename__ = "working_memories"
    __table_args__ = (
        UniqueConstraint("workspace_id", "agent_id", "session_id", "key", postgresql_nulls_not_distinct=True),
        Index("ix_working_memories_expires", "expires_at"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    importance: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()


class Episode(Base):
    __tablename__ = "episodes"
    __table_args__ = (
        UniqueConstraint("workspace_id", "session_id", "task_id", postgresql_nulls_not_distinct=True),
        Index(
            "ix_episodes_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_id: Mapped[str | None] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    importance: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(DIM))
    experience_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = created()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    metadata_json: Mapped[dict[str, Any]] = jsonb()
    updated_at: Mapped[datetime] = created()


class Experience(Base):
    __tablename__ = "experiences"
    __table_args__ = (
        CheckConstraint(_enum_check("outcome", E.Outcome), name="outcome"),
        CheckConstraint(_enum_check("source", E.ExperienceSource), name="source"),
        CheckConstraint("processing_status IN ('pending','processed','failed')", name="processing_status"),
        Index("ix_experiences_ws_created", "workspace_id", "created_at"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_id: Mapped[str | None] = mapped_column(String(200))
    episode_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("episodes.id", ondelete="SET NULL")
    )
    task: Mapped[str] = mapped_column(Text, nullable=False)
    observation: Mapped[str] = mapped_column(Text, nullable=False, default="")
    action: Mapped[str] = mapped_column(Text, nullable=False, default="")
    result: Mapped[str] = mapped_column(Text, nullable=False, default="")
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    importance: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.7)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="agent")
    source_trust: Mapped[float] = mapped_column(Float, nullable=False, default=0.6)
    metadata_json: Mapped[dict[str, Any]] = jsonb()
    processing_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created()


class Memory(Base):
    __tablename__ = "memories"
    __table_args__ = (
        CheckConstraint(_enum_check("type", E.MemoryType), name="type"),
        CheckConstraint(_enum_check("status", E.MemoryStatus), name="status"),
        CheckConstraint(_enum_check("scope_type", E.ScopeType), name="scope_type"),
        CheckConstraint(_enum_check("review_state", E.ReviewState), name="review_state"),
        CheckConstraint("layer IN (3, 4)", name="layer"),
        CheckConstraint(
            "confidence BETWEEN 0 AND 1 AND trust_score BETWEEN 0 AND 1 AND importance BETWEEN 0 AND 1 "
            "AND utility_score BETWEEN 0 AND 1",
            name="scores",
        ),
        CheckConstraint("version >= 1", name="version"),
        Index(
            "ix_memories_active_scope",
            "organization_id",
            "workspace_id",
            "scope_type",
            "scope_id",
            postgresql_where=text("status IN ('active','validated')"),
        ),
        Index("ix_memories_search_tsv", "search_tsv", postgresql_using="gin"),
        Index("ix_memories_ws_status", "workspace_id", "status"),
        Index("ix_memories_content_hash", "workspace_id", "content_hash"),
        Index(
            "ix_memories_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID | None] = ws_fk(nullable=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    layer: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(20), nullable=False)
    scope_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="candidate")
    review_state: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    trust_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    importance: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    utility_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    valid_from: Mapped[datetime] = created()
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(DIM))
    search_tsv: Mapped[Any] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', coalesce(title, '') || ' ' || content)", persisted=True)
    )
    metadata_json: Mapped[dict[str, Any]] = jsonb()
    retrieval_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_type: Mapped[str] = mapped_column(String(30), nullable=False)
    created_by_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()


class MemoryVersion(Base):
    __tablename__ = "memory_versions"
    __table_args__ = (UniqueConstraint("memory_id", "version"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot_json: Mapped[dict[str, Any]] = jsonb()
    change_reason: Mapped[str] = mapped_column(Text, nullable=False)
    actor_type: Mapped[str] = mapped_column(String(30), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = created()


class MemoryEvidence(Base):
    __tablename__ = "memory_evidence"
    __table_args__ = (
        UniqueConstraint("memory_id", "source_type", "source_id", "relation"),
        CheckConstraint(_enum_check("source_type", E.EvidenceSourceType), name="source_type"),
        CheckConstraint("relation IN ('supports','derived_from','contradicts')", name="relation"),
        Index("ix_memory_evidence_source", "source_type", "source_id"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_type: Mapped[str] = mapped_column(String(30), nullable=False)
    source_id: Mapped[str] = mapped_column(String(100), nullable=False)
    relation: Mapped[str] = mapped_column(String(20), nullable=False, default="supports")
    weight: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    excerpt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = created()


class MemoryRelation(Base):
    __tablename__ = "memory_relations"
    __table_args__ = (
        UniqueConstraint("source_memory_id", "target_memory_id", "relation"),
        CheckConstraint(_enum_check("relation", E.RelationType), name="relation"),
        CheckConstraint("source_memory_id <> target_memory_id", name="no_self"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    source_memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    relation: Mapped[str] = mapped_column(String(20), nullable=False)
    metadata_json: Mapped[dict[str, Any]] = jsonb()
    created_at: Mapped[datetime] = created()


class MemoryFeedback(Base):
    __tablename__ = "memory_feedback"
    __table_args__ = (CheckConstraint(_enum_check("value", E.FeedbackValue), name="value"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workspace_id: Mapped[uuid.UUID | None] = ws_fk(nullable=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_id: Mapped[str | None] = mapped_column(String(200))
    retrieval_trace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    value: Mapped[str] = mapped_column(String(20), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = created()


class Conflict(Base):
    __tablename__ = "conflicts"
    __table_args__ = (
        CheckConstraint(_enum_check("status", E.ConflictStatus), name="status"),
        UniqueConstraint("candidate_memory_id", "existing_memory_id"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID | None] = ws_fk(nullable=True)
    candidate_memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False
    )
    existing_memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False
    )
    conflict_type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    analysis_json: Mapped[dict[str, Any]] = jsonb()
    resolution_json: Mapped[dict[str, Any]] = jsonb()
    created_at: Mapped[datetime] = created()
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DreamJob(Base):
    __tablename__ = "dream_jobs"
    __table_args__ = (
        CheckConstraint(_enum_check("mode", E.DreamMode), name="mode"),
        CheckConstraint(_enum_check("status", E.DreamStatus), name="status"),
        CheckConstraint("trigger_type IN ('manual','schedule','event_count','memory_growth')", name="trigger"),
        Index(
            "uq_dream_jobs_window",
            "workspace_id",
            "mode",
            "window_hash",
            unique=True,
            postgresql_where=text("window_hash IS NOT NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    mode: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    trigger_type: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    window_hash: Mapped[str | None] = mapped_column(String(64))
    input_window_json: Mapped[dict[str, Any]] = jsonb()
    result_json: Mapped[dict[str, Any]] = jsonb()
    checkpoint_json: Mapped[dict[str, Any]] = jsonb()
    error: Mapped[str | None] = mapped_column(Text)
    requested_by_id: Mapped[str | None] = mapped_column(String(100))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()


class RetrievalTrace(Base):
    __tablename__ = "retrieval_traces"
    __table_args__ = (Index("ix_retrieval_traces_ws_created", "workspace_id", "created_at"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="context")
    query: Mapped[str] = mapped_column(Text, nullable=False)
    request_json: Mapped[dict[str, Any]] = jsonb()
    candidates_json: Mapped[dict[str, Any]] = jsonb()
    selected_json: Mapped[dict[str, Any]] = jsonb()
    context_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    latency_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created()


class RetrievalTraceItem(Base):
    """Denormalised selected memory per trace: powers 'retrieval usage' on memory detail."""

    __tablename__ = "retrieval_trace_items"
    __table_args__ = (UniqueConstraint("trace_id", "memory_id"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("retrieval_traces.id", ondelete="CASCADE"), nullable=False
    )
    memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = created()


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_org_created", "organization_id", "created_at"),
        Index("ix_audit_logs_resource", "resource_type", "resource_id"),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    actor_type: Mapped[str] = mapped_column(String(30), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(100))
    before_json: Mapped[dict[str, Any]] = jsonb()
    after_json: Mapped[dict[str, Any]] = jsonb()
    request_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = created()


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(_enum_check("status", E.JobStatus), name="status"),
        Index("ix_jobs_ready", "run_after", postgresql_where=text("status IN ('queued','failed')")),
        Index("ix_jobs_running_lease", "locked_until", postgresql_where=text("status = 'running'")),
    )
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    payload_json: Mapped[dict[str, Any]] = jsonb()
    idempotency_key: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    run_after: Mapped[datetime] = created()
    locked_by: Mapped[str | None] = mapped_column(String(100))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    result_json: Mapped[dict[str, Any]] = jsonb()
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = (UniqueConstraint("organization_id", "key"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    path: Mapped[str] = mapped_column(String(300), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[Any] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = created()


class EvalRun(Base):
    __tablename__ = "eval_runs"
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID | None] = ws_fk(nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="completed")
    summary_json: Mapped[dict[str, Any]] = jsonb()
    result_json: Mapped[dict[str, Any]] = jsonb()
    created_at: Mapped[datetime] = created()


class SchedulerState(Base):
    """Checkpoints for periodic schedulers (per workspace + task)."""

    __tablename__ = "scheduler_state"
    __table_args__ = (UniqueConstraint("workspace_id", "task"),)
    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    workspace_id: Mapped[uuid.UUID] = ws_fk()
    task: Mapped[str] = mapped_column(String(50), nullable=False)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    counters_json: Mapped[dict[str, Any]] = jsonb()
    updated_at: Mapped[datetime] = created()


__all__ = [
    "Agent",
    "ApiKey",
    "AuditLog",
    "Conflict",
    "DreamJob",
    "Episode",
    "EvalRun",
    "Event",
    "Experience",
    "IdempotencyRecord",
    "Job",
    "Memory",
    "MemoryEvidence",
    "MemoryFeedback",
    "MemoryRelation",
    "MemoryVersion",
    "Organization",
    "Project",
    "RetrievalTrace",
    "RetrievalTraceItem",
    "SchedulerState",
    "Session",
    "WorkingMemory",
    "Workspace",
]

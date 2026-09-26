"""Memory core: creation, versioned mutation (optimistic concurrency), evidence, relations, history."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.base import utcnow
from app.db.models import (
    Episode,
    Event,
    Experience,
    Memory,
    MemoryEvidence,
    MemoryFeedback,
    MemoryRelation,
    MemoryVersion,
    RetrievalTrace,
    RetrievalTraceItem,
)
from app.domain.enums import (
    PRIVILEGED_TYPES,
    EvidenceSourceType,
    MemoryStatus,
    MemoryType,
    RelationType,
    ReviewState,
    ScopeType,
)
from app.domain.lifecycle import InvalidTransitionError, assert_transition
from app.domain.permissions import Permission
from app.domain.redaction import redact_text, redact_value
from app.domain.text import content_hash
from app.modules import audit
from app.modules.ctx import Ctx
from app.modules.tenancy_service import Refs
from app.tenancy import Conflict, NotFound, PermissionDenied, ValidationFailed

SNAPSHOT_FIELDS = (
    "type",
    "layer",
    "scope_type",
    "scope_id",
    "title",
    "content",
    "status",
    "review_state",
    "confidence",
    "trust_score",
    "importance",
    "utility_score",
    "valid_from",
    "valid_until",
    "metadata_json",
)
PATCHABLE = {
    "title",
    "content",
    "type",
    "importance",
    "confidence",
    "valid_from",
    "valid_until",
    "metadata_json",
    "status",
}


def snapshot(m: Memory) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in SNAPSHOT_FIELDS:
        v = getattr(m, f)
        out[f] = v.isoformat() if isinstance(v, datetime) else str(v) if isinstance(v, uuid.UUID) else v
    out["version"] = m.version
    return out


@dataclass
class EvidenceInput:
    source_type: EvidenceSourceType
    source_id: str
    relation: str = "supports"
    weight: float = 1.0
    excerpt: str = ""


async def embed(ctx: Ctx, text: str) -> list[float]:
    return (await ctx.container.embedder.embed([text]))[0]


def memory_text(title: str, content: str) -> str:
    return f"{title}\n{content}"


def visible_filter(ctx: Ctx) -> Any:
    p = ctx.principal
    cond = Memory.organization_id == p.organization_id
    if p.workspace_ids is not None:
        cond = and_(cond, or_(Memory.workspace_id.is_(None), Memory.workspace_id.in_(p.workspace_ids)))
    return cond


def scope_id_for(refs: Refs, scope_type: ScopeType) -> uuid.UUID:
    match scope_type:
        case ScopeType.ORGANIZATION:
            return refs.workspace.organization_id
        case ScopeType.WORKSPACE:
            return refs.workspace.id
        case ScopeType.PROJECT:
            if not refs.project_id:
                raise ValidationFailed("project scope requires project_id")
            return refs.project_id
        case ScopeType.AGENT:
            if not refs.agent_id:
                raise ValidationFailed("agent scope requires agent_id")
            return refs.agent_id
        case ScopeType.SESSION:
            if not refs.session_id:
                raise ValidationFailed("session scope requires session_id")
            return refs.session_id
    raise ValidationFailed("invalid scope")


async def verify_evidence(ctx: Ctx, evidence: list[EvidenceInput]) -> None:
    """Evidence must reference sources inside the caller's organization (no cross-tenant provenance)."""
    org = ctx.principal.organization_id
    table_for: dict[EvidenceSourceType, Any] = {
        EvidenceSourceType.EXPERIENCE: Experience,
        EvidenceSourceType.EVENT: Event,
        EvidenceSourceType.EPISODE: Episode,
        EvidenceSourceType.MEMORY: Memory,
    }
    for ev in evidence:
        model = table_for.get(ev.source_type)
        if model is None:
            continue
        try:
            sid = uuid.UUID(ev.source_id)
        except ValueError as exc:
            raise ValidationFailed(f"evidence source_id must be a UUID for {ev.source_type}") from exc
        found = await ctx.db.scalar(select(model.id).where(model.id == sid, model.organization_id == org))
        if not found:
            raise NotFound(f"evidence source {ev.source_type}:{ev.source_id} not found")


async def create_memory(
    ctx: Ctx,
    *,
    refs: Refs,
    type: MemoryType,
    scope_type: ScopeType,
    title: str,
    content: str,
    status: MemoryStatus,
    confidence: float,
    trust: float,
    importance: float,
    evidence: list[EvidenceInput],
    reason: str,
    layer: int = 3,
    valid_from: datetime | None = None,
    valid_until: datetime | None = None,
    metadata: dict[str, Any] | None = None,
    review_state: ReviewState = ReviewState.NONE,
    embedding: list[float] | None = None,
) -> Memory:
    title, content = redact_text(title.strip()), redact_text(content.strip())
    if not content:
        raise ValidationFailed("memory content is empty")
    scope_id = scope_id_for(refs, scope_type)
    m = Memory(
        organization_id=refs.workspace.organization_id,
        workspace_id=None if scope_type == ScopeType.ORGANIZATION else refs.workspace.id,
        project_id=refs.project_id,
        agent_id=refs.agent_id,
        layer=layer,
        type=type.value,
        scope_type=scope_type.value,
        scope_id=scope_id,
        title=title[:300],
        content=content,
        content_hash=content_hash(content),
        status=status.value,
        review_state=review_state.value,
        confidence=confidence,
        trust_score=trust,
        importance=importance,
        utility_score=0.5,
        valid_from=valid_from or utcnow(),
        valid_until=valid_until,
        version=1,
        embedding=embedding or await embed(ctx, memory_text(title, content)),
        metadata_json=redact_value(metadata or {}),
        created_by_type=ctx.principal.actor_type,
        created_by_id=ctx.principal.actor_id,
    )
    ctx.db.add(m)
    await ctx.db.flush()
    ctx.db.add(
        MemoryVersion(
            organization_id=m.organization_id,
            memory_id=m.id,
            version=1,
            snapshot_json=snapshot(m),
            change_reason=reason,
            actor_type=ctx.principal.actor_type,
            actor_id=ctx.principal.actor_id,
        )
    )
    for ev in evidence:
        await add_evidence(ctx, m, ev)
    await audit.record(
        ctx,
        "memory.create",
        "memory",
        m.id,
        workspace_id=m.workspace_id,
        after={**snapshot(m), "reason": reason, "evidence": len(evidence)},
    )
    return m


def _base_query(ctx: Ctx) -> Select[Memory]:
    return select(Memory).where(visible_filter(ctx))


async def get_memory(ctx: Ctx, memory_id: uuid.UUID) -> Memory:
    m = await ctx.db.scalar(_base_query(ctx).where(Memory.id == memory_id))
    if m is None:
        raise NotFound("memory not found")
    return m


async def lock_memory(ctx: Ctx, memory_id: uuid.UUID) -> Memory:
    m = await ctx.db.scalar(
        _base_query(ctx).where(Memory.id == memory_id).with_for_update().execution_options(populate_existing=True)
    )
    if m is None:
        raise NotFound("memory not found")
    return m


async def apply_changes(
    ctx: Ctx,
    m: Memory,
    changes: dict[str, Any],
    reason: str,
    *,
    expected_version: int | None = None,
    action: str = "memory.update",
) -> Memory:
    """Versioned mutation. Caller must hold the row lock (lock_memory)."""
    if expected_version is not None and expected_version != m.version:
        raise Conflict("version mismatch", current_version=m.version, expected_version=expected_version)
    before = snapshot(m)
    if "status" in changes and changes["status"] != m.status:
        try:
            assert_transition(MemoryStatus(m.status), MemoryStatus(changes["status"]))
        except InvalidTransitionError as exc:
            raise Conflict(str(exc), current_status=m.status) from exc
    content_changed = False
    for key, value in changes.items():
        if key in ("title", "content") and isinstance(value, str):
            value = redact_text(value.strip())
            content_changed = content_changed or value != getattr(m, key)
        if key == "metadata_json":
            value = redact_value(value)
        setattr(m, key, value)
    if content_changed:
        m.content_hash = content_hash(m.content)
        m.embedding = await embed(ctx, memory_text(m.title, m.content))
    m.version += 1
    m.updated_at = utcnow()
    await ctx.db.flush()
    ctx.db.add(
        MemoryVersion(
            organization_id=m.organization_id,
            memory_id=m.id,
            version=m.version,
            snapshot_json=snapshot(m),
            change_reason=reason,
            actor_type=ctx.principal.actor_type,
            actor_id=ctx.principal.actor_id,
        )
    )
    await audit.record(
        ctx, action, "memory", m.id, workspace_id=m.workspace_id, before=before, after={**snapshot(m), "reason": reason}
    )
    return m


async def transition(
    ctx: Ctx, m: Memory, target: MemoryStatus, reason: str, extra: dict[str, Any] | None = None
) -> Memory:
    if m.status == target.value and not extra:
        return m
    changes: dict[str, Any] = {"status": target.value, **(extra or {})}
    return await apply_changes(ctx, m, changes, reason, action=f"memory.status.{target.value}")


async def evidence_count(ctx: Ctx, memory_id: uuid.UUID) -> int:
    return int(
        await ctx.db.scalar(
            select(func.count()).select_from(MemoryEvidence).where(MemoryEvidence.memory_id == memory_id)
        )
        or 0
    )


async def add_evidence(ctx: Ctx, m: Memory, ev: EvidenceInput) -> bool:
    res = await ctx.db.execute(
        pg_insert(MemoryEvidence)
        .values(
            organization_id=m.organization_id,
            memory_id=m.id,
            source_type=ev.source_type.value,
            source_id=str(ev.source_id),
            relation=ev.relation,
            weight=ev.weight,
            excerpt=redact_text(ev.excerpt)[:1000],
        )
        .on_conflict_do_nothing(index_elements=["memory_id", "source_type", "source_id", "relation"])
        .returning(MemoryEvidence.id)
    )
    return res.scalar_one_or_none() is not None


async def copy_evidence(ctx: Ctx, source: Memory, target: Memory) -> int:
    rows = (await ctx.db.scalars(select(MemoryEvidence).where(MemoryEvidence.memory_id == source.id))).all()
    n = 0
    for r in rows:
        n += await add_evidence(
            ctx, target, EvidenceInput(EvidenceSourceType(r.source_type), r.source_id, r.relation, r.weight, r.excerpt)
        )
    return n


async def add_relation(
    ctx: Ctx, source: Memory, target: Memory, relation: RelationType, metadata: dict[str, Any] | None = None
) -> bool:
    if source.id == target.id:
        raise ValidationFailed("a memory cannot relate to itself")
    if source.organization_id != target.organization_id:
        raise NotFound("memory not found")
    res = await ctx.db.execute(
        pg_insert(MemoryRelation)
        .values(
            organization_id=source.organization_id,
            source_memory_id=source.id,
            target_memory_id=target.id,
            relation=relation.value,
            metadata_json=metadata or {},
        )
        .on_conflict_do_nothing(index_elements=["source_memory_id", "target_memory_id", "relation"])
        .returning(MemoryRelation.id)
    )
    created = res.scalar_one_or_none() is not None
    if created:
        await audit.record(
            ctx,
            "memory.relation.add",
            "memory",
            source.id,
            workspace_id=source.workspace_id,
            after={"target": str(target.id), "relation": relation.value, **(metadata or {})},
        )
    return created


async def supersede(ctx: Ctx, old: Memory, new: Memory, reason: str) -> None:
    """Preserve history: old memory is superseded (never overwritten) and points to its successor."""
    await add_relation(ctx, new, old, RelationType.SUPERSEDES, {"reason": reason})
    await transition(
        ctx,
        old,
        MemoryStatus.SUPERSEDED,
        reason,
        {"metadata_json": {**old.metadata_json, "superseded_by": str(new.id)}},
    )


# ---------------------------------------------------------------- queries
async def list_memories(
    ctx: Ctx,
    *,
    workspace_id: uuid.UUID | None,
    statuses: list[str] | None,
    types: list[str] | None,
    scope_type: str | None,
    project_id: uuid.UUID | None,
    layer: int | None,
    review_state: str | None,
    q: str | None,
    limit: int,
    cursor: uuid.UUID | None,
) -> list[Memory]:
    query = _base_query(ctx)
    if workspace_id:
        query = query.where(or_(Memory.workspace_id == workspace_id, Memory.workspace_id.is_(None)))
    if statuses:
        query = query.where(Memory.status.in_(statuses))
    if types:
        query = query.where(Memory.type.in_(types))
    if scope_type:
        query = query.where(Memory.scope_type == scope_type)
    if project_id:
        query = query.where(Memory.project_id == project_id)
    if layer:
        query = query.where(Memory.layer == layer)
    if review_state:
        query = query.where(Memory.review_state == review_state)
    if q:
        like = f"%{q.replace('%', '').replace('_', '')}%"
        query = query.where(or_(Memory.title.ilike(like), Memory.content.ilike(like)))
    if cursor:
        query = query.where(Memory.id < cursor)
    return list((await ctx.db.scalars(query.order_by(Memory.id.desc()).limit(limit))).all())


async def history(ctx: Ctx, memory_id: uuid.UUID) -> list[MemoryVersion]:
    m = await get_memory(ctx, memory_id)
    return list(
        (
            await ctx.db.scalars(
                select(MemoryVersion).where(MemoryVersion.memory_id == m.id).order_by(MemoryVersion.version)
            )
        ).all()
    )


async def evidence(ctx: Ctx, memory_id: uuid.UUID) -> list[MemoryEvidence]:
    m = await get_memory(ctx, memory_id)
    return list(
        (
            await ctx.db.scalars(
                select(MemoryEvidence).where(MemoryEvidence.memory_id == m.id).order_by(MemoryEvidence.created_at)
            )
        ).all()
    )


async def resolve_evidence_sources(ctx: Ctx, rows: list[MemoryEvidence]) -> dict[str, dict[str, Any]]:
    """Fetch human-readable summaries for evidence sources (same organization only)."""
    org = ctx.principal.organization_id
    out: dict[str, dict[str, Any]] = {}
    exp_ids = [uuid.UUID(r.source_id) for r in rows if r.source_type == "experience"]
    if exp_ids:
        for e in (
            await ctx.db.scalars(
                select(Experience).where(Experience.id.in_(exp_ids), Experience.organization_id == org)
            )
        ).all():
            out[str(e.id)] = {
                "task": e.task,
                "outcome": e.outcome,
                "observation": e.observation,
                "action": e.action,
                "result": e.result,
                "agent_id": str(e.agent_id or ""),
                "source": e.source,
                "created_at": e.created_at.isoformat(),
            }
    mem_ids = [uuid.UUID(r.source_id) for r in rows if r.source_type == "memory"]
    if mem_ids:
        for mm in (
            await ctx.db.scalars(select(Memory).where(Memory.id.in_(mem_ids), Memory.organization_id == org))
        ).all():
            out[str(mm.id)] = {"title": mm.title, "status": mm.status, "type": mm.type}
    ev_ids = [uuid.UUID(r.source_id) for r in rows if r.source_type == "event"]
    if ev_ids:
        for ev in (await ctx.db.scalars(select(Event).where(Event.id.in_(ev_ids), Event.organization_id == org))).all():
            out[str(ev.id)] = {"type": ev.type, "payload": ev.payload_json}
    return out


async def relations(ctx: Ctx, memory_id: uuid.UUID) -> list[tuple[MemoryRelation, Memory]]:
    m = await get_memory(ctx, memory_id)
    other = Memory
    q_out = (
        select(MemoryRelation, other)
        .join(other, other.id == MemoryRelation.target_memory_id)
        .where(MemoryRelation.source_memory_id == m.id, visible_filter(ctx))
    )
    q_in = (
        select(MemoryRelation, other)
        .join(other, other.id == MemoryRelation.source_memory_id)
        .where(MemoryRelation.target_memory_id == m.id, visible_filter(ctx))
    )
    rows = [(r, o) for r, o in (await ctx.db.execute(q_out)).all()]
    rows += [(r, o) for r, o in (await ctx.db.execute(q_in)).all()]
    return rows


async def usage(ctx: Ctx, memory_id: uuid.UUID, limit: int = 50) -> list[tuple[RetrievalTraceItem, RetrievalTrace]]:
    m = await get_memory(ctx, memory_id)
    q = (
        select(RetrievalTraceItem, RetrievalTrace)
        .join(RetrievalTrace, RetrievalTrace.id == RetrievalTraceItem.trace_id)
        .where(RetrievalTraceItem.memory_id == m.id, RetrievalTrace.organization_id == ctx.principal.organization_id)
        .order_by(RetrievalTraceItem.created_at.desc())
        .limit(limit)
    )
    return [(i, t) for i, t in (await ctx.db.execute(q)).all()]


async def feedback_list(ctx: Ctx, memory_id: uuid.UUID) -> list[MemoryFeedback]:
    m = await get_memory(ctx, memory_id)
    return list(
        (
            await ctx.db.scalars(
                select(MemoryFeedback)
                .where(MemoryFeedback.memory_id == m.id)
                .order_by(MemoryFeedback.created_at.desc())
            )
        ).all()
    )


# ---------------------------------------------------------------- API-level operations
def check_can_patch(ctx: Ctx, m: Memory, changes: dict[str, Any]) -> None:
    p = ctx.principal
    if p.can(Permission.MEMORY_REVIEW):
        return
    own_candidate = m.created_by_id == p.actor_id and m.status == MemoryStatus.CANDIDATE.value
    if not (p.can(Permission.MEMORY_PROPOSE) and own_candidate) or "status" in changes:
        raise PermissionDenied("memory:review permission required to modify this memory")


def check_promotion_allowed(ctx: Ctx, m: Memory, target_status: str) -> None:
    if target_status in (MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value):
        ctx.principal.require(Permission.MEMORY_REVIEW)
    if m.layer == 4 or (MemoryType(m.type) in PRIVILEGED_TYPES and m.scope_type in ("organization", "workspace")):
        ctx.principal.require(Permission.MEMORY_REVIEW)

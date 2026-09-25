"""Learning pipeline: experience -> extraction -> candidate -> validation -> decision (see ADR 0004)."""

from __future__ import annotations

import uuid
from typing import Any

import structlog
from sqlalchemy import and_, or_, select

from app.db.base import utcnow
from app.db.models import Conflict, Experience, Memory, MemoryEvidence
from app.domain import contradiction
from app.domain.enums import (
    EvidenceSourceType,
    MemoryStatus,
    MemoryType,
    Outcome,
    RelationType,
    ReviewState,
    ScopeType,
    ValidationDecision,
)
from app.domain.poisoning import assess_injection, is_policy_like
from app.domain.policy import OBSERVATIONAL_TYPES, CandidateFacts, PolicyConfig, decide
from app.jobs import queue
from app.modules import audit, experience_service, memory_service
from app.modules.ctx import Ctx
from app.modules.memory_service import EvidenceInput
from app.modules.tenancy_service import Refs
from app.observability import metrics
from app.providers.base import structured
from app.providers.schemas import ContradictionOut, ExtractionOut

log = structlog.get_logger(__name__)


def policy_config(ctx: Ctx) -> PolicyConfig:
    s = ctx.settings
    return PolicyConfig(
        min_candidate_confidence=s.min_candidate_confidence,
        auto_promote_min_confidence=s.auto_promote_min_confidence,
        auto_promote_min_trust=s.auto_promote_min_trust,
    )


async def _refs_for(
    ctx: Ctx,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID | None,
    agent_id: uuid.UUID | None,
    session_id: uuid.UUID | None,
) -> Refs:
    from app.db.models import Workspace

    ws = await ctx.db.get(Workspace, workspace_id)
    assert ws is not None
    return Refs(ws, project_id, agent_id, session_id)


# ---------------------------------------------------------------- extraction
async def process_experience(ctx: Ctx, experience_id: uuid.UUID) -> dict[str, Any]:
    exp = await ctx.db.scalar(
        select(Experience)
        .where(Experience.id == experience_id, Experience.organization_id == ctx.principal.organization_id)
        .with_for_update()
    )
    if exp is None:
        return {"skipped": "experience not found"}
    if exp.processing_status == "processed":
        return {"skipped": "already processed"}
    episode = await experience_service.upsert_episode(ctx, exp)
    payload = {
        "experience": experience_service._exp_payload(exp),
        "episode_summary": episode.summary if episode else None,
    }
    out = await structured(ctx.container.llm, "memory_extraction", payload, ExtractionOut)
    refs = await _refs_for(ctx, exp.workspace_id, exp.project_id, exp.agent_id, exp.session_id)
    scope = ScopeType.PROJECT if exp.project_id else ScopeType.WORKSPACE
    created: list[str] = []
    for i, cand in enumerate(out.candidates):
        evidence = [
            EvidenceInput(
                EvidenceSourceType.EXPERIENCE,
                str(exp.id),
                "derived_from",
                1.0,
                f"{exp.task} | {exp.observation} | {exp.action} | {exp.result}",
            )
        ]
        if episode:
            evidence.append(
                EvidenceInput(EvidenceSourceType.EPISODE, str(episode.id), "supports", 0.5, episode.summary[:500])
            )
        m = await memory_service.create_memory(
            ctx,
            refs=refs,
            type=cand.type,
            scope_type=scope,
            title=cand.title,
            content=cand.content,
            status=MemoryStatus.CANDIDATE,
            confidence=min(cand.confidence, exp.confidence),
            trust=exp.source_trust,
            importance=cand.importance,
            evidence=evidence,
            reason="extracted from experience",
            metadata={
                "extraction": {
                    "experience_id": str(exp.id),
                    "index": i,
                    "rationale": cand.rationale,
                    "source": exp.source,
                    "outcome": exp.outcome,
                    "provider": ctx.container.llm.name,
                }
            },
        )
        await queue.enqueue(
            ctx.db,
            kind=queue.VALIDATE_CANDIDATE,
            payload={"memory_id": str(m.id)},
            idempotency_key=f"validate:{m.id}",
            organization_id=m.organization_id,
            workspace_id=m.workspace_id,
            max_attempts=ctx.settings.job_max_attempts,
        )
        created.append(str(m.id))
    exp.processing_status = "processed"
    exp.processed_at = utcnow()
    ctx.wake_workers = bool(created)
    metrics.CANDIDATES_EXTRACTED.inc(len(created))
    await audit.record(
        ctx,
        "experience.extracted",
        "experience",
        exp.id,
        workspace_id=exp.workspace_id,
        after={"candidates": created, "episode_id": str(episode.id) if episode else None},
    )
    return {"candidates": created, "episode_id": str(episode.id) if episode else None}


# ---------------------------------------------------------------- validation
def _related_scope_filter(m: Memory) -> Any:
    if m.scope_type == ScopeType.ORGANIZATION.value:
        return Memory.organization_id == m.organization_id
    if m.scope_type == ScopeType.WORKSPACE.value:
        return or_(
            Memory.workspace_id == m.workspace_id,
            and_(Memory.scope_type == "organization", Memory.organization_id == m.organization_id),
        )
    return or_(
        and_(Memory.scope_type == m.scope_type, Memory.scope_id == m.scope_id),
        and_(Memory.scope_type == "workspace", Memory.scope_id == m.workspace_id),
        and_(Memory.scope_type == "organization", Memory.organization_id == m.organization_id),
    )


async def related_memories(ctx: Ctx, m: Memory, limit: int = 10) -> list[tuple[Memory, float]]:
    distance = Memory.embedding.cosine_distance(m.embedding)
    q = (
        select(Memory, (1 - distance).label("sim"))
        .where(
            Memory.organization_id == m.organization_id,
            Memory.id != m.id,
            Memory.status.in_([MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value]),
            or_(Memory.valid_until.is_(None), Memory.valid_until > utcnow()),
            Memory.embedding.is_not(None),
            _related_scope_filter(m),
        )
        .order_by(distance)
        .limit(limit)
    )
    rows = [(r, float(s)) for r, s in (await ctx.db.execute(q)).all()]
    exact = (
        await ctx.db.scalars(
            select(Memory).where(
                Memory.organization_id == m.organization_id,
                Memory.id != m.id,
                Memory.content_hash == m.content_hash,
                Memory.status.in_([MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value]),
                _related_scope_filter(m),
            )
        )
    ).all()
    seen = {r.id for r, _ in rows}
    rows = [(e, 1.0) for e in exact if e.id not in seen] + rows
    return rows


async def _has_success_evidence(ctx: Ctx, m: Memory) -> bool:
    exp_ids = (
        await ctx.db.scalars(
            select(MemoryEvidence.source_id).where(
                MemoryEvidence.memory_id == m.id, MemoryEvidence.source_type == "experience"
            )
        )
    ).all()
    if not exp_ids:
        return False
    return bool(
        await ctx.db.scalar(
            select(Experience.id)
            .where(Experience.id.in_([uuid.UUID(x) for x in exp_ids]), Experience.outcome == Outcome.SUCCESS.value)
            .limit(1)
        )
    )


async def _evidence_text(ctx: Ctx, m: Memory) -> str:
    rows = (await ctx.db.scalars(select(MemoryEvidence.excerpt).where(MemoryEvidence.memory_id == m.id))).all()
    return "\n".join(rows)


async def validate_candidate(ctx: Ctx, memory_id: uuid.UUID) -> dict[str, Any]:
    m = await memory_service.lock_memory(ctx, memory_id)
    if m.status != MemoryStatus.CANDIDATE.value or m.review_state != ReviewState.NONE.value:
        return {"skipped": f"memory is {m.status}/{m.review_state}"}
    if m.embedding is None:
        m.embedding = await memory_service.embed(ctx, memory_service.memory_text(m.title, m.content))
        await ctx.db.flush()

    related = await related_memories(ctx, m)
    s = ctx.settings
    duplicate_of: Memory | None = None
    contradicts: Memory | None = None
    analysis: dict[str, Any] = {}
    supports: list[Memory] = []
    judged: list[dict[str, Any]] = []
    for other, sim in related[:6]:
        if other.content_hash == m.content_hash or sim >= s.dedup_threshold:
            duplicate_of = duplicate_of or other
            judged.append({"id": str(other.id), "similarity": round(sim, 4), "relation": "duplicate"})
            continue
        if sim < s.contradiction_similarity_threshold:
            continue
        observational = MemoryType(m.type) in OBSERVATIONAL_TYPES or MemoryType(other.type) in OBSERVATIONAL_TYPES
        judgment = await structured(
            ctx.container.llm, "contradiction_judgment", {"a": other.content, "b": m.content}, ContradictionOut
        )
        rel = judgment.relation
        signal = contradiction.detect(other.content, m.content)
        judged.append(
            {"id": str(other.id), "similarity": round(sim, 4), "relation": rel, "explanation": judgment.explanation}
        )
        if rel in ("contradicts", "supersedes") and not observational and contradicts is None:
            contradicts = other
            analysis = {
                "similarity": round(sim, 4),
                "judgment": judgment.model_dump(),
                "rule_signal": {
                    "contradicts": signal.contradicts,
                    "kind": signal.kind,
                    "overlap": round(signal.topical_overlap, 3),
                    "supersede_hint": signal.supersede_hint,
                },
            }
        elif rel == "duplicate" and sim >= s.related_threshold and duplicate_of is None:
            duplicate_of = other
        elif rel == "supports" and sim >= s.related_threshold:
            supports.append(other)

    injection = assess_injection(m.title, m.content, await _evidence_text(ctx, m))
    if injection.flags:
        metrics.POISONING_FLAGGED.inc()
    created_by_reviewer = m.created_by_type in ("api_key", "admin_cli") and m.trust_score >= 0.85
    facts = CandidateFacts(
        type=MemoryType(m.type),
        layer=m.layer,
        scope_type=m.scope_type,
        confidence=m.confidence,
        trust=m.trust_score,
        injection=injection,
        policy_like=is_policy_like(m.content),
        has_success_evidence=await _has_success_evidence(ctx, m),
        duplicate_of=str(duplicate_of.id) if duplicate_of else None,
        contradicts=str(contradicts.id) if contradicts else None,
        created_by_reviewer=created_by_reviewer,
    )
    result = decide(facts, policy_config(ctx))
    validation_meta = {
        "decision": result.decision.value,
        "reasons": result.reasons,
        "related": judged,
        "injection": {"score": injection.score, "flags": injection.flags},
        "at": utcnow().isoformat(),
    }
    metrics.VALIDATION_DECISIONS.labels(decision=result.decision.value).inc()
    meta = {**m.metadata_json, "validation": validation_meta}
    if injection.flags:
        meta["flags"] = sorted(set(meta.get("flags", [])) | set(injection.flags))
    D = ValidationDecision
    if result.decision == D.MERGE and duplicate_of is not None:
        target = await memory_service.lock_memory(ctx, duplicate_of.id)
        copied = await memory_service.copy_evidence(ctx, m, target)
        await memory_service.add_evidence(
            ctx, target, EvidenceInput(EvidenceSourceType.MEMORY, str(m.id), "supports", 1.0, m.content[:500])
        )
        reinforced = round(min(0.98, target.confidence + (1 - target.confidence) * 0.15 * m.confidence), 4)
        await memory_service.apply_changes(
            ctx,
            target,
            {"confidence": reinforced},
            f"merged duplicate candidate {m.id} (+{copied} evidence)",
            action="memory.merge",
        )
        await memory_service.add_relation(ctx, m, target, RelationType.SUPPORTS, {"reason": "duplicate merged"})
        await memory_service.transition(
            ctx,
            m,
            MemoryStatus.REJECTED,
            f"merged into {target.id}",
            {"metadata_json": {**meta, "merged_into": str(target.id)}},
        )
    elif result.decision == D.DISPUTE and contradicts is not None:
        conflict = Conflict(
            organization_id=m.organization_id,
            workspace_id=m.workspace_id,
            candidate_memory_id=m.id,
            existing_memory_id=contradicts.id,
            conflict_type=analysis.get("rule_signal", {}).get("kind") or "contradiction",
            analysis_json=analysis,
        )
        ctx.db.add(conflict)
        await ctx.db.flush()
        await memory_service.add_relation(
            ctx, m, contradicts, RelationType.CONTRADICTS, {"conflict_id": str(conflict.id)}
        )
        await memory_service.transition(
            ctx,
            m,
            MemoryStatus.DISPUTED,
            f"contradicts {contradicts.id}",
            {"metadata_json": {**meta, "conflict_id": str(conflict.id)}},
        )
        await audit.record(
            ctx,
            "conflict.open",
            "conflict",
            conflict.id,
            workspace_id=m.workspace_id,
            after={"candidate": str(m.id), "existing": str(contradicts.id), **analysis},
        )
        metrics.CONFLICTS_OPENED.inc()
    elif result.decision == D.REJECT:
        await memory_service.transition(
            ctx, m, MemoryStatus.REJECTED, "; ".join(result.reasons), {"metadata_json": meta}
        )
    elif result.decision == D.REQUIRE_REVIEW:
        await memory_service.apply_changes(
            ctx,
            m,
            {"review_state": ReviewState.PENDING.value, "metadata_json": meta},
            "requires review: " + "; ".join(result.reasons),
            action="memory.review.requested",
        )
    else:
        await promote(ctx, m, "; ".join(result.reasons), meta)
        for other in supports:
            await memory_service.add_relation(ctx, m, other, RelationType.RELATED_TO, {"reason": "supports"})
    return {"decision": result.decision.value, "reasons": result.reasons, "memory_id": str(m.id)}


async def promote(ctx: Ctx, m: Memory, reason: str, meta: dict[str, Any] | None = None) -> Memory:
    """candidate -> validated -> active, each step versioned. Requires evidence (or privileged human source)."""
    if await memory_service.evidence_count(ctx, m.id) == 0 and m.created_by_type not in ("api_key", "admin_cli"):
        raise ValueError("cannot promote a memory without evidence")
    extra = {"metadata_json": meta} if meta is not None else None
    if m.status == MemoryStatus.CANDIDATE.value:
        await memory_service.transition(ctx, m, MemoryStatus.VALIDATED, f"validated: {reason}", extra)
        extra = None
    await memory_service.transition(ctx, m, MemoryStatus.ACTIVE, f"promoted: {reason}", extra)
    return m


async def review(ctx: Ctx, memory_id: uuid.UUID, approve: bool, note: str, expected_version: int | None) -> Memory:
    """Human/maintainer review of a pending candidate."""
    from app.domain.permissions import Permission

    ctx.principal.require(Permission.MEMORY_REVIEW)
    m = await memory_service.lock_memory(ctx, memory_id)
    if expected_version is not None and m.version != expected_version:
        from app.tenancy import Conflict as ConflictError

        raise ConflictError("version mismatch", current_version=m.version, expected_version=expected_version)
    if m.status != MemoryStatus.CANDIDATE.value:
        from app.tenancy import Conflict as ConflictError

        raise ConflictError(f"memory is {m.status}, only candidates can be reviewed", current_status=m.status)
    meta = {
        **m.metadata_json,
        "review": {"approved": approve, "note": note, "by": ctx.principal.actor_id, "at": utcnow().isoformat()},
    }
    if approve:
        await memory_service.apply_changes(
            ctx,
            m,
            {"review_state": ReviewState.APPROVED.value},
            f"review approved: {note}",
            action="memory.review.approved",
        )
        await memory_service.add_evidence(
            ctx,
            m,
            EvidenceInput(
                EvidenceSourceType.USER_STATEMENT,
                ctx.principal.actor_id,
                "supports",
                1.0,
                f"approved by reviewer: {note}",
            ),
        )
        await promote(ctx, m, f"approved by {ctx.principal.actor_id}", meta)
    else:
        await memory_service.transition(
            ctx,
            m,
            MemoryStatus.REJECTED,
            f"review rejected: {note}",
            {"review_state": ReviewState.REJECTED.value, "metadata_json": meta},
        )
    return m

"""Conflict listing and resolution (manual or policy-driven)."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select

from app.db.base import utcnow
from app.db.models import Conflict, Memory, MemoryFeedback
from app.domain.enums import ConflictResolution, ConflictStatus, MemoryStatus, RelationType
from app.domain.permissions import Permission
from app.modules import audit, memory_service
from app.modules.ctx import Ctx
from app.tenancy import Conflict as ConflictError
from app.tenancy import NotFound


async def get_conflict(ctx: Ctx, conflict_id: uuid.UUID) -> Conflict:
    ctx.principal.require(Permission.MEMORY_READ)
    c = await ctx.db.scalar(
        select(Conflict).where(Conflict.id == conflict_id, Conflict.organization_id == ctx.principal.organization_id)
    )
    if c is None or (c.workspace_id and not ctx.principal.can_access_workspace(c.workspace_id)):
        raise NotFound("conflict not found")
    return c


async def list_conflicts(
    ctx: Ctx, *, workspace_id: uuid.UUID | None, status: str | None, limit: int, cursor: uuid.UUID | None
) -> list[Conflict]:
    ctx.principal.require(Permission.MEMORY_READ)
    q = select(Conflict).where(Conflict.organization_id == ctx.principal.organization_id)
    if ctx.principal.workspace_ids is not None:
        q = q.where(Conflict.workspace_id.in_(ctx.principal.workspace_ids))
    if workspace_id:
        q = q.where(Conflict.workspace_id == workspace_id)
    if status:
        q = q.where(Conflict.status == status)
    if cursor:
        q = q.where(Conflict.id < cursor)
    return list((await ctx.db.scalars(q.order_by(Conflict.id.desc()).limit(limit))).all())


async def resolve(
    ctx: Ctx, conflict_id: uuid.UUID, resolution: ConflictResolution, note: str = "", *, auto: bool = False
) -> Conflict:
    ctx.principal.require(Permission.MEMORY_REVIEW)
    c = await ctx.db.scalar(
        select(Conflict)
        .where(Conflict.id == conflict_id, Conflict.organization_id == ctx.principal.organization_id)
        .with_for_update()
    )
    if c is None:
        raise NotFound("conflict not found")
    if c.status != ConflictStatus.OPEN.value:
        raise ConflictError("conflict already resolved", status=c.status)
    cand = await memory_service.lock_memory(ctx, c.candidate_memory_id)
    existing = await memory_service.lock_memory(ctx, c.existing_memory_id)
    reason = f"conflict {c.id} resolved: {resolution.value}" + (f" ({note})" if note else "")

    async def reactivate(m: Memory) -> None:
        if m.status == MemoryStatus.DISPUTED.value:
            await memory_service.transition(ctx, m, MemoryStatus.ACTIVE, reason)

    match resolution:
        case ConflictResolution.KEEP_EXISTING:
            if cand.status not in (
                MemoryStatus.REJECTED.value,
                MemoryStatus.ARCHIVED.value,
                MemoryStatus.SUPERSEDED.value,
            ):
                target = MemoryStatus.REJECTED if cand.status in ("candidate", "disputed") else MemoryStatus.ARCHIVED
                await memory_service.transition(ctx, cand, target, reason)
            await reactivate(existing)
        case ConflictResolution.ACCEPT_CANDIDATE:
            await reactivate(cand)
            if cand.status == MemoryStatus.CANDIDATE.value:
                await memory_service.transition(ctx, cand, MemoryStatus.ACTIVE, reason)
            if existing.status in (MemoryStatus.ACTIVE.value, MemoryStatus.DISPUTED.value):
                await memory_service.supersede(ctx, existing, cand, reason)
        case ConflictResolution.KEEP_BOTH:
            await reactivate(cand)
            await reactivate(existing)
            await memory_service.add_relation(ctx, cand, existing, RelationType.RELATED_TO, {"reason": reason})
        case ConflictResolution.ARCHIVE_BOTH:
            for m in (cand, existing):
                if m.status in (MemoryStatus.ACTIVE.value, MemoryStatus.DISPUTED.value, MemoryStatus.VALIDATED.value):
                    await memory_service.transition(ctx, m, MemoryStatus.ARCHIVED, reason)
                elif m.status == MemoryStatus.CANDIDATE.value:
                    await memory_service.transition(ctx, m, MemoryStatus.REJECTED, reason)
    c.status = ConflictStatus.RESOLVED.value
    c.resolved_at = utcnow()
    c.resolution_json = {"resolution": resolution.value, "note": note, "by": ctx.principal.actor_id, "auto": auto}
    await audit.record(ctx, "conflict.resolve", "conflict", c.id, workspace_id=c.workspace_id, after=c.resolution_json)
    return c


async def _negative_feedback(ctx: Ctx, memory_id: uuid.UUID) -> int:
    return int(
        await ctx.db.scalar(
            select(func.count())
            .select_from(MemoryFeedback)
            .where(
                MemoryFeedback.memory_id == memory_id, MemoryFeedback.value.in_(["incorrect", "outdated", "harmful"])
            )
        )
        or 0
    )


async def auto_resolution(ctx: Ctx, c: Conflict) -> tuple[ConflictResolution | None, str]:
    """Conservative policy used by the contradiction dream; returns None when a human should decide."""
    cand = await ctx.db.get(Memory, c.candidate_memory_id)
    existing = await ctx.db.get(Memory, c.existing_memory_id)
    if cand is None or existing is None:
        return None, "missing memory"
    if cand.metadata_json.get("flags"):
        return None, "candidate flagged by poisoning detector"
    if existing.layer == 4:
        return None, "organizational memory requires human resolution"
    neg_existing = await _negative_feedback(ctx, existing.id)
    hint = (
        bool(c.analysis_json.get("rule_signal", {}).get("supersede_hint"))
        or c.analysis_json.get("judgment", {}).get("relation") == "supersedes"
    )
    if neg_existing >= ctx.settings.feedback_dispute_threshold and cand.trust_score >= existing.trust_score * 0.8:
        return ConflictResolution.ACCEPT_CANDIDATE, f"existing memory received {neg_existing} negative feedback"
    if hint and cand.trust_score >= existing.trust_score and cand.confidence >= existing.confidence - 0.1:
        return ConflictResolution.ACCEPT_CANDIDATE, "candidate explicitly supersedes existing with equal/higher trust"
    neg_cand = await _negative_feedback(ctx, cand.id)
    if neg_cand >= ctx.settings.feedback_dispute_threshold:
        return ConflictResolution.KEEP_EXISTING, f"candidate received {neg_cand} negative feedback"
    return None, "insufficient evidence for automatic resolution"

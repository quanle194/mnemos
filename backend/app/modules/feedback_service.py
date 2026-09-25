"""Feedback and utility learning. Feedback never rewrites memory content (spec)."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select

from app.db.base import utcnow
from app.db.models import MemoryFeedback
from app.domain.enums import FeedbackValue, MemoryStatus
from app.domain.permissions import Permission
from app.domain.redaction import redact_text
from app.modules import audit, memory_service
from app.modules.ctx import Ctx
from app.observability.metrics import FEEDBACK_TOTAL

# (utility delta factor, trust delta factor): positive factors move toward 1, negative toward 0.
EFFECTS: dict[FeedbackValue, tuple[float, float]] = {
    FeedbackValue.HELPFUL: (0.2, 0.02),
    FeedbackValue.IRRELEVANT: (-0.1, 0.0),
    FeedbackValue.INCORRECT: (-0.2, -0.15),
    FeedbackValue.OUTDATED: (-0.1, -0.05),
    FeedbackValue.HARMFUL: (-0.3, -0.3),
}


def apply_delta(value: float, factor: float) -> float:
    if factor >= 0:
        return round(min(1.0, value + factor * (1 - value)), 4)
    return round(max(0.0, value + factor * value), 4)


async def add_feedback(ctx: Ctx, memory_id: uuid.UUID, value: FeedbackValue, *, note: str = "",
                       agent_id: uuid.UUID | None = None, session_id: uuid.UUID | None = None,
                       task_id: str | None = None, retrieval_trace_id: uuid.UUID | None = None
                       ) -> tuple[MemoryFeedback, dict[str, object]]:
    ctx.principal.require(Permission.FEEDBACK_WRITE)
    m = await memory_service.lock_memory(ctx, memory_id)
    fb = MemoryFeedback(organization_id=m.organization_id, memory_id=m.id, workspace_id=m.workspace_id,
                        agent_id=agent_id, session_id=session_id, task_id=task_id,
                        retrieval_trace_id=retrieval_trace_id, value=value.value, note=redact_text(note)[:2000],
                        created_by_id=ctx.principal.actor_id)
    ctx.db.add(fb)
    await ctx.db.flush()
    before = {"utility_score": m.utility_score, "trust_score": m.trust_score, "status": m.status}
    u_factor, t_factor = EFFECTS[value]
    m.utility_score = apply_delta(m.utility_score, u_factor)
    m.trust_score = apply_delta(m.trust_score, t_factor)
    m.updated_at = utcnow()
    counts = dict((await ctx.db.execute(
        select(MemoryFeedback.value, func.count()).where(MemoryFeedback.memory_id == m.id)
        .group_by(MemoryFeedback.value))).all())
    lifecycle_action = None
    retrievable = m.status in (MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value)
    s = ctx.settings
    if value == FeedbackValue.HARMFUL and retrievable:
        await memory_service.transition(ctx, m, MemoryStatus.DISPUTED, "quarantined after harmful feedback")
        lifecycle_action = "quarantined"
    elif value == FeedbackValue.INCORRECT and retrievable and counts.get("incorrect", 0) >= s.feedback_dispute_threshold:
        await memory_service.transition(ctx, m, MemoryStatus.DISPUTED,
                                        f"disputed after {counts['incorrect']} incorrect feedback")
        lifecycle_action = "disputed"
    elif value == FeedbackValue.OUTDATED and m.valid_until is None and \
            counts.get("outdated", 0) >= s.feedback_outdated_threshold:
        await memory_service.apply_changes(ctx, m, {"valid_until": utcnow()},
                                           f"expired after {counts['outdated']} outdated feedback",
                                           action="memory.expire")
        lifecycle_action = "expired"
    await audit.record(ctx, "memory.feedback", "memory", m.id, workspace_id=m.workspace_id, before=before,
                       after={"utility_score": m.utility_score, "trust_score": m.trust_score, "status": m.status,
                              "feedback": value.value, "lifecycle_action": lifecycle_action})
    FEEDBACK_TOTAL.labels(value=value.value).inc()
    return fb, {"utility_score": m.utility_score, "trust_score": m.trust_score, "status": m.status,
                "lifecycle_action": lifecycle_action, "counts": counts}

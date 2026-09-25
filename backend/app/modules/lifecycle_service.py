"""Lifecycle / expiry / archival / forgetting policy.

Never deletes evidence or history: memories move to `archived`; only L1 working memory is physically purged.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select

from app.db.base import utcnow
from app.db.models import Memory
from app.domain.enums import MemoryStatus
from app.modules import events_service, memory_service
from app.modules.ctx import Ctx


def decay_score(
    *, importance: float, utility: float, age_days: float, days_since_use: float, half_life_days: float
) -> float:
    """Retention score in [0,1]: high importance/utility and recent use keep memories warm."""
    freshness = math.exp(-days_since_use / max(half_life_days, 1) * math.log(2))
    return round(0.4 * importance + 0.4 * utility + 0.2 * freshness, 4)


async def sweep(ctx: Ctx, now: datetime | None = None, batch: int = 500) -> dict[str, Any]:
    now = now or utcnow()
    s = ctx.settings
    org = ctx.principal.organization_id
    purged = await events_service.purge_expired_working_memory(ctx)

    expired_ids = (
        await ctx.db.scalars(
            select(Memory.id)
            .where(
                Memory.organization_id == org,
                Memory.valid_until.is_not(None),
                Memory.valid_until <= now,
                Memory.status.in_(
                    [MemoryStatus.ACTIVE.value, MemoryStatus.VALIDATED.value, MemoryStatus.DISPUTED.value]
                ),
            )
            .limit(batch)
        )
    ).all()
    for mid in expired_ids:
        m = await memory_service.lock_memory(ctx, mid)
        await memory_service.transition(
            ctx,
            m,
            MemoryStatus.ARCHIVED,
            "expired (valid_until passed)",
            {"metadata_json": {**m.metadata_json, "archived_reason": "expired"}},
        )

    cutoff = now - timedelta(days=s.lifecycle_cold_after_days)
    cold_ids = (
        await ctx.db.scalars(
            select(Memory.id)
            .where(
                Memory.organization_id == org,
                Memory.status == MemoryStatus.ACTIVE.value,
                Memory.layer == 3,
                Memory.importance < 0.7,
                Memory.utility_score < s.lifecycle_cold_utility_threshold,
                or_(
                    and_(Memory.last_retrieved_at.is_(None), Memory.created_at < cutoff),
                    Memory.last_retrieved_at < cutoff,
                ),
            )
            .limit(batch)
        )
    ).all()
    for mid in cold_ids:
        m = await memory_service.lock_memory(ctx, mid)
        age = (now - m.created_at).total_seconds() / 86400
        since = (now - (m.last_retrieved_at or m.created_at)).total_seconds() / 86400
        score = decay_score(
            importance=m.importance,
            utility=m.utility_score,
            age_days=age,
            days_since_use=since,
            half_life_days=s.recency_half_life_days,
        )
        await memory_service.transition(
            ctx,
            m,
            MemoryStatus.ARCHIVED,
            f"cold: retention score {score}",
            {"metadata_json": {**m.metadata_json, "archived_reason": "cold", "retention_score": score}},
        )
    superseded_old = int(
        await ctx.db.scalar(
            select(func.count())
            .select_from(Memory)
            .where(Memory.organization_id == org, Memory.status == MemoryStatus.SUPERSEDED.value)
        )
        or 0
    )
    return {
        "working_memory_purged": purged,
        "expired_archived": len(expired_ids),
        "cold_archived": len(cold_ids),
        "superseded_total": superseded_old,
    }

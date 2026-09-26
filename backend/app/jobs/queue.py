"""Durable job queue on PostgreSQL (see ADR 0002)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import new_id, utcnow
from app.db.models import Job
from app.domain.enums import JobStatus

EXTRACT_EXPERIENCE = "extract_experience"
VALIDATE_CANDIDATE = "validate_candidate"
RUN_DREAM = "run_dream"
LIFECYCLE_SWEEP = "lifecycle_sweep"
EMBED_MEMORY = "embed_memory"

JOB_KINDS = (EXTRACT_EXPERIENCE, VALIDATE_CANDIDATE, RUN_DREAM, LIFECYCLE_SWEEP, EMBED_MEMORY)


async def enqueue(
    db: AsyncSession,
    *,
    kind: str,
    payload: dict[str, Any],
    idempotency_key: str,
    organization_id: uuid.UUID | None,
    workspace_id: uuid.UUID | None = None,
    run_after: datetime | None = None,
    max_attempts: int = 5,
) -> uuid.UUID | None:
    """Insert a job in the caller's transaction. Returns the job id, or None if the key already existed."""
    if kind not in JOB_KINDS:
        raise ValueError(f"unknown job kind {kind}")
    stmt = (
        insert(Job)
        .values(
            id=new_id(),
            organization_id=organization_id,
            workspace_id=workspace_id,
            kind=kind,
            payload_json=payload,
            idempotency_key=idempotency_key,
            status=JobStatus.QUEUED.value,
            max_attempts=max_attempts,
            run_after=run_after or utcnow(),
        )
        .on_conflict_do_nothing(index_elements=[Job.idempotency_key])
        .returning(Job.id)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


_CLAIM_SQL = text(
    """
    UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = :worker,
           locked_until = now() + make_interval(secs => :lease), updated_at = now()
    WHERE id = (
        SELECT id FROM jobs
        WHERE (status IN ('queued', 'failed') AND run_after <= now())
           OR (status = 'running' AND locked_until < now())
        ORDER BY run_after, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id
    """
)


async def claim(db: AsyncSession, worker_id: str, lease_seconds: int) -> Job | None:
    job_id = (await db.execute(_CLAIM_SQL, {"worker": worker_id, "lease": lease_seconds})).scalar_one_or_none()
    if job_id is None:
        await db.commit()
        return None
    job = await db.get(Job, job_id, populate_existing=True)
    await db.commit()
    return job


async def extend_lease(db: AsyncSession, job_id: uuid.UUID, worker_id: str, lease_seconds: int) -> None:
    await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.locked_by == worker_id, Job.status == "running")
        .values(locked_until=utcnow() + timedelta(seconds=lease_seconds))
    )
    await db.commit()


async def complete(db: AsyncSession, job_id: uuid.UUID, worker_id: str, result: dict[str, Any]) -> None:
    await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.locked_by == worker_id)
        .values(
            status=JobStatus.SUCCEEDED.value,
            result_json=result,
            locked_until=None,
            completed_at=utcnow(),
            updated_at=utcnow(),
            last_error=None,
        )
    )
    await db.commit()


def backoff_seconds(attempts: int) -> int:
    return min(600, 2 ** max(0, attempts))


async def fail(db: AsyncSession, job: Job, worker_id: str, error: str) -> str:
    dead = job.attempts >= job.max_attempts
    status = JobStatus.DEAD if dead else JobStatus.FAILED
    await db.execute(
        update(Job)
        .where(Job.id == job.id, Job.locked_by == worker_id)
        .values(
            status=status.value,
            last_error=error[:4000],
            locked_until=None,
            updated_at=utcnow(),
            run_after=utcnow() + timedelta(seconds=backoff_seconds(job.attempts)),
        )
    )
    await db.commit()
    return status.value


async def depth(db: AsyncSession) -> dict[str, int]:
    rows = (await db.execute(select(Job.status, func.count()).group_by(Job.status))).all()
    return {status: int(count) for status, count in rows}


async def retry_dead(db: AsyncSession, job_id: uuid.UUID, organization_id: uuid.UUID) -> bool:
    res = await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.organization_id == organization_id, Job.status == "dead")
        .values(status="queued", attempts=0, run_after=utcnow(), updated_at=utcnow(), last_error=None)
    )
    return (res.rowcount or 0) > 0  # type: ignore[attr-defined]

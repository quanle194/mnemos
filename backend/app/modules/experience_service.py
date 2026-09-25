"""Experience ingestion (with redaction + source trust) and L2 episodes."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.db.base import utcnow
from app.db.models import Episode, Experience, Job, Memory, MemoryEvidence
from app.domain.enums import ExperienceSource, Outcome
from app.domain.permissions import Permission
from app.domain.redaction import redact_text, redact_value
from app.jobs import queue
from app.modules import audit, tenancy_service
from app.modules.ctx import Ctx
from app.observability.metrics import EXPERIENCES_INGESTED
from app.providers.base import structured
from app.providers.schemas import EpisodeSummaryOut
from app.tenancy import NotFound

SOURCE_TRUST_FACTOR: dict[ExperienceSource, float] = {
    ExperienceSource.AGENT: 1.0,
    ExperienceSource.USER: 1.0,
    ExperienceSource.TOOL: 0.6,
    ExperienceSource.EXTERNAL: 0.35,
}


async def create_experience(
    ctx: Ctx,
    *,
    workspace_id: uuid.UUID,
    task: str,
    outcome: Outcome,
    observation: str = "",
    action: str = "",
    result: str = "",
    project_id: uuid.UUID | None = None,
    agent_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    task_id: str | None = None,
    project_name: str | None = None,
    agent_name: str | None = None,
    importance: float = 0.5,
    confidence: float = 0.7,
    source: ExperienceSource = ExperienceSource.AGENT,
    metadata: dict[str, Any] | None = None,
) -> tuple[Experience, uuid.UUID | None]:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    tenancy_service.ensure_text_limits(ctx.settings, task=task, observation=observation, action=action, result=result)
    refs = await tenancy_service.resolve_refs(
        ctx,
        workspace_id=workspace_id,
        project_id=project_id,
        agent_id=agent_id,
        session_id=session_id,
        project_name=project_name,
        agent_name=agent_name,
        create_session=True,
    )
    trust = round(ctx.principal.source_trust * SOURCE_TRUST_FACTOR[source], 4)
    exp = Experience(
        organization_id=refs.workspace.organization_id,
        workspace_id=refs.workspace.id,
        project_id=refs.project_id,
        agent_id=refs.agent_id,
        session_id=refs.session_id,
        task_id=task_id,
        task=redact_text(task),
        observation=redact_text(observation),
        action=redact_text(action),
        result=redact_text(result),
        outcome=outcome.value,
        importance=importance,
        confidence=confidence,
        source=source.value,
        source_trust=trust,
        metadata_json=redact_value(metadata or {}),
        created_by_id=None,
    )
    ctx.db.add(exp)
    await ctx.db.flush()
    job_id = await queue.enqueue(
        ctx.db,
        kind=queue.EXTRACT_EXPERIENCE,
        payload={"experience_id": str(exp.id)},
        idempotency_key=f"extract:{exp.id}",
        organization_id=exp.organization_id,
        workspace_id=exp.workspace_id,
        max_attempts=ctx.settings.job_max_attempts,
    )
    ctx.wake_workers = True
    await audit.record(
        ctx,
        "experience.create",
        "experience",
        exp.id,
        workspace_id=exp.workspace_id,
        after={"task": exp.task[:200], "outcome": exp.outcome, "source": exp.source, "source_trust": trust},
    )
    EXPERIENCES_INGESTED.labels(outcome=exp.outcome).inc()
    return exp, job_id


async def get_experience(ctx: Ctx, experience_id: uuid.UUID) -> Experience:
    ctx.principal.require(Permission.MEMORY_READ)
    exp = await ctx.db.scalar(
        select(Experience).where(
            Experience.id == experience_id, Experience.organization_id == ctx.principal.organization_id
        )
    )
    if exp is None or not ctx.principal.can_access_workspace(exp.workspace_id):
        raise NotFound("experience not found")
    return exp


async def experience_learning(ctx: Ctx, exp: Experience) -> dict[str, Any]:
    job = await ctx.db.scalar(select(Job).where(Job.idempotency_key == f"extract:{exp.id}"))
    mem_ids = (
        await ctx.db.scalars(
            select(MemoryEvidence.memory_id).where(
                MemoryEvidence.source_type == "experience",
                MemoryEvidence.source_id == str(exp.id),
                MemoryEvidence.organization_id == exp.organization_id,
            )
        )
    ).all()
    memories = []
    if mem_ids:
        memories = [
            {"id": str(m.id), "title": m.title, "status": m.status, "type": m.type}
            for m in (await ctx.db.scalars(select(Memory).where(Memory.id.in_(mem_ids)))).all()
        ]
    return {
        "job_id": str(job.id) if job else None,
        "job_status": job.status if job else None,
        "processing_status": exp.processing_status,
        "memories": memories,
    }


async def list_experiences(
    ctx: Ctx,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID | None,
    agent_id: uuid.UUID | None,
    outcome: str | None,
    limit: int,
    cursor: uuid.UUID | None,
) -> list[Experience]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    q = select(Experience).where(
        Experience.workspace_id == ws.id, Experience.organization_id == ctx.principal.organization_id
    )
    if project_id:
        q = q.where(Experience.project_id == project_id)
    if agent_id:
        q = q.where(Experience.agent_id == agent_id)
    if outcome:
        q = q.where(Experience.outcome == outcome)
    if cursor:
        q = q.where(Experience.id < cursor)
    return list((await ctx.db.scalars(q.order_by(Experience.id.desc()).limit(limit))).all())


async def upsert_episode(ctx: Ctx, exp: Experience) -> Episode | None:
    """Group experiences of the same session/task into an L2 episode (summary refreshed via LLM)."""
    if exp.session_id is None and exp.task_id is None:
        return None
    ep = await ctx.db.scalar(
        select(Episode)
        .where(
            Episode.workspace_id == exp.workspace_id,
            Episode.session_id.is_not_distinct_from(exp.session_id),
            Episode.task_id.is_not_distinct_from(exp.task_id),
        )
        .with_for_update()
    )
    if ep is None:
        ep = Episode(
            organization_id=exp.organization_id,
            workspace_id=exp.workspace_id,
            project_id=exp.project_id,
            agent_id=exp.agent_id,
            session_id=exp.session_id,
            task_id=exp.task_id,
            summary=exp.task,
            started_at=exp.created_at,
        )
        ctx.db.add(ep)
        await ctx.db.flush()
    exp.episode_id = ep.id
    await ctx.db.flush()
    members = (
        await ctx.db.scalars(select(Experience).where(Experience.episode_id == ep.id).order_by(Experience.created_at))
    ).all()
    payload = {"experiences": [_exp_payload(e) for e in members]}
    out = await structured(ctx.container.llm, "episode_summary", payload, EpisodeSummaryOut)
    ep.summary = redact_text(out.summary)
    ep.outcome = out.outcome
    ep.importance = out.importance
    ep.confidence = sum(e.confidence for e in members) / len(members)
    ep.experience_count = len(members)
    ep.embedding = (await ctx.container.embedder.embed([ep.summary]))[0]
    ep.updated_at = utcnow()
    if exp.outcome in (Outcome.SUCCESS.value, Outcome.FAILURE.value):
        ep.completed_at = exp.created_at
    return ep


def _exp_payload(e: Experience) -> dict[str, Any]:
    return {
        "id": str(e.id),
        "task": e.task,
        "observation": e.observation,
        "action": e.action,
        "result": e.result,
        "outcome": e.outcome,
        "importance": e.importance,
        "confidence": e.confidence,
        "source": e.source,
        "metadata": e.metadata_json,
    }


async def list_episodes(ctx: Ctx, *, workspace_id: uuid.UUID, limit: int, cursor: uuid.UUID | None) -> list[Episode]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    q = select(Episode).where(Episode.workspace_id == ws.id, Episode.organization_id == ctx.principal.organization_id)
    if cursor:
        q = q.where(Episode.id < cursor)
    return list((await ctx.db.scalars(q.order_by(Episode.id.desc()).limit(limit))).all())


async def get_episode(ctx: Ctx, episode_id: uuid.UUID) -> tuple[Episode, list[Experience]]:
    ctx.principal.require(Permission.MEMORY_READ)
    ep = await ctx.db.scalar(
        select(Episode).where(Episode.id == episode_id, Episode.organization_id == ctx.principal.organization_id)
    )
    if ep is None or not ctx.principal.can_access_workspace(ep.workspace_id):
        raise NotFound("episode not found")
    exps = list(
        (
            await ctx.db.scalars(
                select(Experience).where(Experience.episode_id == ep.id).order_by(Experience.created_at)
            )
        ).all()
    )
    return ep, exps

"""Operational endpoints: jobs, audit, retrieval traces, stats, knowledge graph, evals."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from app.api.deps import CtxDep
from app.api.errors import ApiError
from app.db.base import utcnow
from app.db.models import (
    Conflict,
    DreamJob,
    EvalRun,
    Experience,
    Job,
    Memory,
    MemoryFeedback,
    MemoryRelation,
    RetrievalTrace,
)
from app.domain.permissions import Permission
from app.jobs import queue
from app.modules import audit, retrieval_service, tenancy_service
from app.modules.memory_service import visible_filter
from app.schemas.api import AuditOut, EvalRunIn, EvalRunOut, JobOut, TraceOut
from app.schemas.common import page

router = APIRouter(prefix="/v1", tags=["operations"])


@router.get("/jobs")
async def list_jobs(ctx: CtxDep, workspace_id: uuid.UUID | None = None, status: str | None = None,
                    kind: str | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                    cursor: uuid.UUID | None = None) -> dict:
    ctx.principal.require(Permission.MEMORY_READ)
    q = select(Job).where(Job.organization_id == ctx.principal.organization_id)
    if ctx.principal.workspace_ids is not None:
        q = q.where(Job.workspace_id.in_(ctx.principal.workspace_ids))
    if workspace_id:
        q = q.where(Job.workspace_id == workspace_id)
    if status:
        q = q.where(Job.status == status)
    if kind:
        q = q.where(Job.kind == kind)
    if cursor:
        q = q.where(Job.id < cursor)
    items = list((await ctx.db.scalars(q.order_by(Job.id.desc()).limit(limit))).all())
    return page(items, limit, JobOut)


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: uuid.UUID, ctx: CtxDep) -> dict:
    ctx.principal.require(Permission.MEMORY_REVIEW)
    ok = await queue.retry_dead(ctx.db, job_id, ctx.principal.organization_id)
    if not ok:
        raise ApiError(404, "not_found", "dead job not found")
    await audit.record(ctx, "job.retry", "job", job_id)
    ctx.wake_workers = True
    await ctx.commit()
    return {"requeued": True}


@router.get("/audit-logs")
async def audit_logs(ctx: CtxDep, workspace_id: uuid.UUID | None = None, resource_id: str | None = None,
                     action: str | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                     cursor: uuid.UUID | None = None) -> dict:
    ctx.principal.require(Permission.MEMORY_READ)
    items = await audit.list_logs(ctx, workspace_id=workspace_id, resource_id=resource_id, action=action,
                                  limit=limit, cursor=cursor)
    return page(items, limit, AuditOut)


@router.get("/retrieval-traces")
async def traces(ctx: CtxDep, workspace_id: uuid.UUID, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                 cursor: uuid.UUID | None = None) -> dict:
    return page(await retrieval_service.list_traces(ctx, workspace_id, limit, cursor), limit, TraceOut)


@router.get("/retrieval-traces/{trace_id}", response_model=TraceOut)
async def trace(trace_id: uuid.UUID, ctx: CtxDep) -> TraceOut:
    return TraceOut.model_validate(await retrieval_service.get_trace(ctx, trace_id))


def _counts(rows: Any) -> dict[str, int]:
    return {str(k): int(v) for k, v in rows}


@router.get("/stats")
async def stats(ctx: CtxDep, workspace_id: uuid.UUID) -> dict[str, Any]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    mem_scope = or_(Memory.workspace_id == ws.id, Memory.workspace_id.is_(None))
    base = [Memory.organization_id == ctx.principal.organization_id, mem_scope]
    db = ctx.db
    since = utcnow() - timedelta(hours=24)
    trace_row = (await db.execute(select(func.count(), func.avg(RetrievalTrace.latency_ms),
                                         func.avg(RetrievalTrace.context_tokens)).where(
        RetrievalTrace.workspace_id == ws.id, RetrievalTrace.created_at >= since))).one()
    return {
        "workspace_id": str(ws.id),
        "memories_by_status": _counts((await db.execute(select(Memory.status, func.count()).where(*base)
                                                        .group_by(Memory.status))).all()),
        "memories_by_type": _counts((await db.execute(select(Memory.type, func.count()).where(
            *base, Memory.status == "active").group_by(Memory.type))).all()),
        "memories_by_layer": _counts((await db.execute(select(Memory.layer, func.count()).where(
            *base, Memory.status == "active").group_by(Memory.layer))).all()),
        "pending_review": int(await db.scalar(select(func.count()).select_from(Memory).where(
            *base, Memory.review_state == "pending", Memory.status == "candidate")) or 0),
        "experiences_by_outcome": _counts((await db.execute(select(Experience.outcome, func.count()).where(
            Experience.workspace_id == ws.id).group_by(Experience.outcome))).all()),
        "conflicts_by_status": _counts((await db.execute(select(Conflict.status, func.count()).where(
            Conflict.workspace_id == ws.id).group_by(Conflict.status))).all()),
        "dreams_by_status": _counts((await db.execute(select(DreamJob.status, func.count()).where(
            DreamJob.workspace_id == ws.id).group_by(DreamJob.status))).all()),
        "jobs_by_status": _counts((await db.execute(select(Job.status, func.count()).where(
            Job.workspace_id == ws.id).group_by(Job.status))).all()),
        "feedback_by_value": _counts((await db.execute(select(MemoryFeedback.value, func.count()).where(
            MemoryFeedback.workspace_id == ws.id).group_by(MemoryFeedback.value))).all()),
        "retrieval_24h": {"count": int(trace_row[0] or 0), "avg_latency_ms": round(float(trace_row[1] or 0), 2),
                          "avg_context_tokens": round(float(trace_row[2] or 0), 1)},
    }


@router.get("/graph")
async def graph(ctx: CtxDep, workspace_id: uuid.UUID, include_inactive: bool = False,
                limit: Annotated[int, Query(ge=1, le=1000)] = 300) -> dict[str, Any]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    q = select(Memory).where(visible_filter(ctx), or_(Memory.workspace_id == ws.id, Memory.workspace_id.is_(None)))
    if not include_inactive:
        q = q.where(Memory.status.in_(["active", "validated", "disputed", "superseded"]))
    mems = list((await ctx.db.scalars(q.order_by(Memory.updated_at.desc()).limit(limit))).all())
    ids = [m.id for m in mems]
    rels = (await ctx.db.scalars(select(MemoryRelation).where(MemoryRelation.source_memory_id.in_(ids),
                                                              MemoryRelation.target_memory_id.in_(ids)))).all()
    return {
        "nodes": [{"id": str(m.id), "title": m.title, "type": m.type, "status": m.status, "layer": m.layer,
                   "confidence": m.confidence, "utility": m.utility_score} for m in mems],
        "edges": [{"id": str(r.id), "source": str(r.source_memory_id), "target": str(r.target_memory_id),
                   "relation": r.relation} for r in rels],
    }


@router.post("/evals/runs", status_code=201, response_model=EvalRunOut)
async def store_eval(body: EvalRunIn, ctx: CtxDep) -> EvalRunOut:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    if body.workspace_id:
        await tenancy_service.get_workspace(ctx, body.workspace_id)
    run = EvalRun(organization_id=ctx.principal.organization_id, workspace_id=body.workspace_id, name=body.name,
                  summary_json=body.summary, result_json=body.result)
    ctx.db.add(run)
    await ctx.db.flush()
    out = EvalRunOut.model_validate(run)
    await ctx.commit()
    return out


@router.get("/evals/runs")
async def list_evals(ctx: CtxDep, workspace_id: uuid.UUID | None = None,
                     limit: Annotated[int, Query(ge=1, le=200)] = 50, cursor: uuid.UUID | None = None) -> dict:
    ctx.principal.require(Permission.MEMORY_READ)
    q = select(EvalRun).where(EvalRun.organization_id == ctx.principal.organization_id)
    if workspace_id:
        q = q.where(EvalRun.workspace_id == workspace_id)
    if cursor:
        q = q.where(EvalRun.id < cursor)
    return page(list((await ctx.db.scalars(q.order_by(EvalRun.id.desc()).limit(limit))).all()), limit, EvalRunOut)

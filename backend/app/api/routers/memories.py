from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Header, Query, Request, Response
from fastapi.responses import JSONResponse

from app.api import idempotency
from app.api.deps import CtxDep
from app.api.errors import ApiError
from app.domain.enums import EvidenceSourceType, MemoryStatus, ReviewState, ScopeType
from app.domain.permissions import Permission
from app.jobs import queue
from app.modules import feedback_service, learning_service, memory_service, retrieval_service, tenancy_service
from app.modules.memory_service import EvidenceInput
from app.modules.retrieval_service import RetrievalRequest
from app.schemas.api import (
    EvidenceOut,
    FeedbackIn,
    FeedbackOut,
    FeedbackResult,
    MemoryIn,
    MemoryOut,
    MemoryPatch,
    PromoteIn,
    RelationIn,
    RelationOut,
    ReviewIn,
    ScoredMemory,
    SearchIn,
    SearchOut,
    UsageOut,
    VersionOut,
)
from app.schemas.common import page

router = APIRouter(prefix="/v1/memories", tags=["memories"])


def _etag(version: int) -> str:
    return f'"{version}"'


def _parse_if_match(value: str | None) -> int | None:
    if not value:
        return None
    v = value.strip().removeprefix("W/").strip('"')
    try:
        return int(v)
    except ValueError as exc:
        raise ApiError(422, "validation_error", "If-Match must contain the integer memory version") from exc


@router.post("", status_code=201, response_model=MemoryOut)
async def create_memory(body: MemoryIn, request: Request, ctx: CtxDep,
                        idempotency_key: Annotated[str | None, Header()] = None) -> JSONResponse:
    ctx.principal.require(Permission.MEMORY_PROPOSE)
    privileged = body.status == "active" or body.layer == 4 or body.scope_type == ScopeType.ORGANIZATION
    if privileged:
        ctx.principal.require(Permission.MEMORY_REVIEW)

    async def handler() -> MemoryOut:
        tenancy_service.ensure_text_limits(ctx.settings, content=body.content)
        refs = await tenancy_service.resolve_refs(ctx, workspace_id=body.workspace_id, project_id=body.project_id,
                                                  agent_id=body.agent_id, session_id=body.session_id,
                                                  project_name=body.project_name, agent_name=body.agent_name)
        evidence = [EvidenceInput(e.source_type, e.source_id, e.relation, e.weight, e.excerpt) for e in body.evidence]
        await memory_service.verify_evidence(ctx, evidence)
        if not evidence:
            evidence = [EvidenceInput(EvidenceSourceType.USER_STATEMENT, ctx.principal.actor_id, "supports", 1.0,
                                      body.content[:500])]
        m = await memory_service.create_memory(
            ctx, refs=refs, type=body.type, scope_type=body.scope_type, title=body.title, content=body.content,
            status=MemoryStatus.CANDIDATE, confidence=body.confidence, trust=ctx.principal.source_trust,
            importance=body.importance, evidence=evidence, reason="proposed via API", layer=body.layer,
            valid_from=body.valid_from, valid_until=body.valid_until, metadata=body.metadata,
        )
        if body.status == "active":
            await learning_service.promote(ctx, m, f"created active by reviewer {ctx.principal.actor_id}")
        else:
            await queue.enqueue(ctx.db, kind=queue.VALIDATE_CANDIDATE, payload={"memory_id": str(m.id)},
                                idempotency_key=f"validate:{m.id}", organization_id=m.organization_id,
                                workspace_id=m.workspace_id, max_attempts=ctx.settings.job_max_attempts)
            ctx.wake_workers = True
        return MemoryOut.model_validate(m)

    return await idempotency.run(ctx, idempotency_key, "POST", request.url.path, body.model_dump(), 201, handler)


@router.get("")
async def list_memories(ctx: CtxDep, workspace_id: uuid.UUID | None = None,
                        status: Annotated[list[str] | None, Query()] = None,
                        type: Annotated[list[str] | None, Query()] = None, scope_type: str | None = None,
                        project_id: uuid.UUID | None = None, layer: int | None = None,
                        review_state: str | None = None, q: str | None = None,
                        limit: Annotated[int, Query(ge=1, le=200)] = 50, cursor: uuid.UUID | None = None) -> dict:
    ctx.principal.require(Permission.MEMORY_READ)
    if workspace_id:
        await tenancy_service.get_workspace(ctx, workspace_id)
    items = await memory_service.list_memories(ctx, workspace_id=workspace_id, statuses=status, types=type,
                                               scope_type=scope_type, project_id=project_id, layer=layer,
                                               review_state=review_state, q=q, limit=limit, cursor=cursor)
    return page(items, limit, MemoryOut)


@router.post("/search", response_model=SearchOut)
async def search(body: SearchIn, ctx: CtxDep) -> SearchOut:
    scope_mode = body.scope_mode or ("chain" if (body.project_id or body.agent_id or body.session_id)
                                     else "workspace")
    req = RetrievalRequest(workspace_id=body.workspace_id, query=body.query, project_id=body.project_id,
                           agent_id=body.agent_id, session_id=body.session_id,
                           types=[t.value for t in body.types] if body.types else None,
                           statuses=[s.value for s in body.statuses] if body.statuses else None,
                           layers=list(body.layers) if body.layers else None, scope_mode=scope_mode,
                           valid_at=body.valid_at, limit=body.limit, min_relevance=body.min_relevance)
    items, trace_id = await retrieval_service.search(ctx, req)
    out = SearchOut(items=[ScoredMemory(memory=MemoryOut.model_validate(s.memory), score=s.breakdown.total,
                                        scores=s.breakdown.as_dict(), reasons=s.breakdown.reasons) for s in items],
                    retrieval_trace_id=trace_id, weights=ctx.settings.rank_weights)
    await ctx.commit()
    return out


@router.get("/{memory_id}", response_model=MemoryOut)
async def get_memory(memory_id: uuid.UUID, ctx: CtxDep, response: Response) -> MemoryOut:
    ctx.principal.require(Permission.MEMORY_READ)
    m = await memory_service.get_memory(ctx, memory_id)
    response.headers["ETag"] = _etag(m.version)
    return MemoryOut.model_validate(m)


@router.patch("/{memory_id}", response_model=MemoryOut)
async def patch_memory(memory_id: uuid.UUID, body: MemoryPatch, ctx: CtxDep, response: Response,
                       if_match: Annotated[str | None, Header()] = None) -> MemoryOut:
    expected = _parse_if_match(if_match) or body.expected_version
    if expected is None:
        raise ApiError(428, "precondition_required", "PATCH requires If-Match header or expected_version")
    changes: dict[str, Any] = body.model_dump(exclude_unset=True, exclude={"expected_version", "reason"})
    if "metadata" in changes:
        changes["metadata_json"] = changes.pop("metadata")
    if "type" in changes and changes["type"] is not None:
        changes["type"] = changes["type"].value
    if "status" in changes and changes["status"] is not None:
        changes["status"] = changes["status"].value
    changes = {k: v for k, v in changes.items() if v is not None or k == "valid_until"}
    if not changes:
        raise ApiError(422, "validation_error", "no changes supplied")
    m = await memory_service.lock_memory(ctx, memory_id)
    memory_service.check_can_patch(ctx, m, changes)
    if "status" in changes:
        memory_service.check_promotion_allowed(ctx, m, changes["status"])
    m = await memory_service.apply_changes(ctx, m, changes, body.reason, expected_version=expected)
    out = MemoryOut.model_validate(m)
    await ctx.commit()
    response.headers["ETag"] = _etag(m.version)
    return out


@router.delete("/{memory_id}", response_model=MemoryOut)
async def archive_memory(memory_id: uuid.UUID, ctx: CtxDep, if_match: Annotated[str | None, Header()] = None,
                         reason: str = "archived via API") -> MemoryOut:
    """DELETE archives (never hard-deletes) the memory; evidence and history are preserved."""
    m = await memory_service.lock_memory(ctx, memory_id)
    memory_service.check_can_patch(ctx, m, {})
    expected = _parse_if_match(if_match)
    if expected is not None and expected != m.version:
        from app.tenancy import Conflict

        raise Conflict("version mismatch", current_version=m.version, expected_version=expected)
    target = MemoryStatus.REJECTED if m.status == MemoryStatus.CANDIDATE.value else MemoryStatus.ARCHIVED
    if m.status not in (MemoryStatus.ARCHIVED.value, MemoryStatus.REJECTED.value):
        await memory_service.transition(ctx, m, target, reason)
    out = MemoryOut.model_validate(m)
    await ctx.commit()
    return out


@router.post("/{memory_id}/feedback", status_code=201, response_model=FeedbackResult)
async def feedback(memory_id: uuid.UUID, body: FeedbackIn, request: Request, ctx: CtxDep,
                   idempotency_key: Annotated[str | None, Header()] = None) -> JSONResponse:
    async def handler() -> FeedbackResult:
        fb, mem = await feedback_service.add_feedback(ctx, memory_id, body.value, note=body.note,
                                                      agent_id=body.agent_id, session_id=body.session_id,
                                                      task_id=body.task_id, retrieval_trace_id=body.retrieval_trace_id)
        return FeedbackResult(feedback=FeedbackOut.model_validate(fb), memory=mem)

    return await idempotency.run(ctx, idempotency_key, "POST", request.url.path, body.model_dump(), 201, handler)


@router.get("/{memory_id}/feedback", response_model=list[FeedbackOut])
async def list_feedback(memory_id: uuid.UUID, ctx: CtxDep) -> list[FeedbackOut]:
    ctx.principal.require(Permission.MEMORY_READ)
    return [FeedbackOut.model_validate(f) for f in await memory_service.feedback_list(ctx, memory_id)]


@router.get("/{memory_id}/history", response_model=list[VersionOut])
async def history(memory_id: uuid.UUID, ctx: CtxDep) -> list[VersionOut]:
    ctx.principal.require(Permission.MEMORY_READ)
    return [VersionOut.model_validate(v) for v in await memory_service.history(ctx, memory_id)]


@router.get("/{memory_id}/evidence", response_model=list[EvidenceOut])
async def evidence(memory_id: uuid.UUID, ctx: CtxDep) -> list[EvidenceOut]:
    ctx.principal.require(Permission.MEMORY_READ)
    rows = await memory_service.evidence(ctx, memory_id)
    sources = await memory_service.resolve_evidence_sources(ctx, rows)
    return [EvidenceOut.model_validate({**EvidenceOut.model_validate(r).model_dump(), "source": sources.get(r.source_id)})
            for r in rows]


@router.get("/{memory_id}/relations", response_model=list[RelationOut])
async def relations(memory_id: uuid.UUID, ctx: CtxDep) -> list[RelationOut]:
    ctx.principal.require(Permission.MEMORY_READ)
    out = []
    for rel, other in await memory_service.relations(ctx, memory_id):
        out.append(RelationOut(id=rel.id, relation=rel.relation,
                               direction="outgoing" if rel.source_memory_id == memory_id else "incoming",
                               other={"id": str(other.id), "title": other.title, "status": other.status,
                                      "type": other.type},
                               metadata=rel.metadata_json, created_at=rel.created_at))
    return out


@router.post("/{memory_id}/relations", status_code=201)
async def add_relation(memory_id: uuid.UUID, body: RelationIn, ctx: CtxDep) -> dict:
    ctx.principal.require(Permission.MEMORY_REVIEW)
    src = await memory_service.get_memory(ctx, memory_id)
    tgt = await memory_service.get_memory(ctx, body.target_memory_id)
    created = await memory_service.add_relation(ctx, src, tgt, body.relation, body.metadata)
    await ctx.commit()
    return {"created": created}


@router.get("/{memory_id}/usage", response_model=list[UsageOut])
async def usage(memory_id: uuid.UUID, ctx: CtxDep) -> list[UsageOut]:
    ctx.principal.require(Permission.MEMORY_READ)
    return [UsageOut(trace_id=t.id, kind=t.kind, query=t.query, rank=i.rank, score=i.score, agent_id=t.agent_id,
                     created_at=t.created_at) for i, t in await memory_service.usage(ctx, memory_id)]


@router.post("/{memory_id}/review", response_model=MemoryOut)
async def review(memory_id: uuid.UUID, body: ReviewIn, ctx: CtxDep) -> MemoryOut:
    m = await learning_service.review(ctx, memory_id, body.approve, body.note, body.expected_version)
    out = MemoryOut.model_validate(m)
    await ctx.commit()
    return out


@router.post("/{memory_id}/promote", response_model=MemoryOut)
async def promote_l4(memory_id: uuid.UUID, body: PromoteIn, ctx: CtxDep) -> MemoryOut:
    """Promote an active memory to L4 organizational/shared knowledge (review permission, audited)."""
    ctx.principal.require(Permission.MEMORY_REVIEW)
    m = await memory_service.lock_memory(ctx, memory_id)
    if m.status != MemoryStatus.ACTIVE.value:
        raise ApiError(409, "conflict", "only active memories can be promoted to L4", {"status": m.status})
    changes: dict[str, Any] = {"layer": 4, "review_state": ReviewState.APPROVED.value,
                               "scope_type": body.scope_type}
    if body.scope_type == "organization":
        changes.update(scope_id=m.organization_id, workspace_id=None)
    else:
        if m.workspace_id is None:
            raise ApiError(422, "validation_error", "organization memory cannot be narrowed to a workspace")
        changes.update(scope_id=m.workspace_id)
    m = await memory_service.apply_changes(ctx, m, changes, f"promoted to L4 {body.scope_type}: {body.note}",
                                           expected_version=body.expected_version, action="memory.promote.l4")
    out = MemoryOut.model_validate(m)
    await ctx.commit()
    return out

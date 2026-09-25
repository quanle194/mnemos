from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CtxDep
from app.modules import retrieval_service, tenancy_service
from app.modules.retrieval_service import RetrievalRequest
from app.schemas.api import ContextIn, ContextMemory, ContextOut

router = APIRouter(prefix="/v1", tags=["retrieval"])


@router.post("/context", response_model=ContextOut)
async def context(body: ContextIn, ctx: CtxDep) -> ContextOut:
    project_id, agent_id = await tenancy_service.lookup_ids(
        ctx,
        body.workspace_id,
        project_id=body.project_id,
        project_name=body.project_name,
        agent_id=body.agent_id,
        agent_name=body.agent_name,
    )
    req = RetrievalRequest(
        workspace_id=body.workspace_id,
        query=body.query,
        project_id=project_id,
        agent_id=agent_id,
        session_id=body.session_id,
        types=[t.value for t in body.memory_types] if body.memory_types else None,
        include_candidates=body.include_candidates,
        scope_mode="chain",
        limit=body.max_items,
        min_relevance=body.min_relevance,
    )
    res = await retrieval_service.build_context(ctx, req, body.token_budget)
    out = ContextOut(
        context=res.rendered,
        memories=[
            ContextMemory(
                id=i.scored.memory.id,
                type=i.scored.memory.type,
                title=i.scored.memory.title,
                content=i.scored.memory.content,
                scope_type=i.scored.memory.scope_type,
                status=i.scored.memory.status,
                confidence=i.scored.memory.confidence,
                trust_score=i.scored.memory.trust_score,
                importance=i.scored.memory.importance,
                utility_score=i.scored.memory.utility_score,
                version=i.scored.memory.version,
                score=i.scored.breakdown.total,
                scores=i.scored.breakdown.as_dict(),
                reasons=i.scored.breakdown.reasons,
                tokens=i.tokens,
                evidence=i.evidence,
            )
            for i in res.items
        ],
        token_estimate=res.token_estimate,
        token_budget=res.token_budget,
        retrieval_trace_id=res.trace_id,
        candidate_count=res.candidate_count,
        excluded=res.excluded,
    )
    await ctx.commit()
    return out

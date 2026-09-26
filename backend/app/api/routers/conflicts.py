from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import CtxDep
from app.db.models import Memory
from app.modules import conflict_service
from app.schemas.api import ConflictDetail, ConflictOut, MemoryOut, ResolveIn
from app.schemas.common import page

router = APIRouter(prefix="/v1/conflicts", tags=["conflicts"])


@router.get("")
async def list_conflicts(
    ctx: CtxDep,
    workspace_id: uuid.UUID | None = None,
    status: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: uuid.UUID | None = None,
) -> dict:
    items = await conflict_service.list_conflicts(
        ctx, workspace_id=workspace_id, status=status, limit=limit, cursor=cursor
    )
    return page(items, limit, ConflictOut)


async def _detail(ctx: CtxDep, c) -> ConflictDetail:  # type: ignore[no-untyped-def]
    cand = await ctx.db.get(Memory, c.candidate_memory_id)
    existing = await ctx.db.get(Memory, c.existing_memory_id)
    return ConflictDetail.model_validate(
        {
            **ConflictOut.model_validate(c).model_dump(),
            "candidate": MemoryOut.model_validate(cand) if cand else None,
            "existing": MemoryOut.model_validate(existing) if existing else None,
        }
    )


@router.get("/{conflict_id}", response_model=ConflictDetail)
async def get_conflict(conflict_id: uuid.UUID, ctx: CtxDep) -> ConflictDetail:
    return await _detail(ctx, await conflict_service.get_conflict(ctx, conflict_id))


@router.post("/{conflict_id}/resolve", response_model=ConflictDetail)
async def resolve(conflict_id: uuid.UUID, body: ResolveIn, ctx: CtxDep) -> ConflictDetail:
    await conflict_service.get_conflict(ctx, conflict_id)
    c = await conflict_service.resolve(ctx, conflict_id, body.resolution, body.note)
    out = await _detail(ctx, c)
    await ctx.commit()
    return out

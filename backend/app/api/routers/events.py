from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import JSONResponse

from app.api import idempotency
from app.api.deps import CtxDep
from app.modules import events_service
from app.schemas.api import EventOut, EventsIn, WorkingMemoryIn, WorkingMemoryOut
from app.schemas.common import page

router = APIRouter(prefix="/v1", tags=["events"])


@router.post("/events", status_code=201)
async def create_events(body: EventsIn, request: Request, ctx: CtxDep,
                        idempotency_key: Annotated[str | None, Header()] = None) -> JSONResponse:
    async def handler() -> dict:
        evs = await events_service.record_events(
            ctx, workspace_id=body.workspace_id, items=[e.model_dump() for e in body.events],
            project_id=body.project_id, agent_id=body.agent_id, session_id=body.session_id,
            agent_name=body.agent_name, project_name=body.project_name)
        return {"items": [EventOut.model_validate(e) for e in evs]}

    return await idempotency.run(ctx, idempotency_key, "POST", request.url.path, body.model_dump(), 201, handler)


@router.get("/events")
async def list_events(ctx: CtxDep, workspace_id: uuid.UUID, session_id: uuid.UUID | None = None,
                      task_id: str | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                      cursor: uuid.UUID | None = None) -> dict:
    items = await events_service.list_events(ctx, workspace_id=workspace_id, session_id=session_id, task_id=task_id,
                                             limit=limit, cursor=cursor)
    return page(items, limit, EventOut)


@router.put("/working-memory", response_model=WorkingMemoryOut)
async def put_working_memory(body: WorkingMemoryIn, ctx: CtxDep) -> WorkingMemoryOut:
    wm = await events_service.put_working_memory(ctx, workspace_id=body.workspace_id, key=body.key,
                                                 content=body.content, agent_id=body.agent_id,
                                                 session_id=body.session_id, ttl_seconds=body.ttl_seconds,
                                                 importance=body.importance)
    out = WorkingMemoryOut.model_validate(wm)
    await ctx.commit()
    return out


@router.get("/working-memory", response_model=list[WorkingMemoryOut])
async def list_working_memory(ctx: CtxDep, workspace_id: uuid.UUID, agent_id: uuid.UUID | None = None,
                              session_id: uuid.UUID | None = None) -> list[WorkingMemoryOut]:
    items = await events_service.list_working_memory(ctx, workspace_id=workspace_id, agent_id=agent_id,
                                                     session_id=session_id)
    return [WorkingMemoryOut.model_validate(i) for i in items]


@router.delete("/working-memory/{wm_id}", status_code=204)
async def delete_working_memory(wm_id: uuid.UUID, ctx: CtxDep) -> None:
    await events_service.delete_working_memory(ctx, wm_id)
    await ctx.commit()

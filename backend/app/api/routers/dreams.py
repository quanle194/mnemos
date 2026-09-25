from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import JSONResponse

from app.api import idempotency
from app.api.deps import CtxDep
from app.modules import dreaming_service
from app.schemas.api import DreamIn, DreamOut
from app.schemas.common import page

router = APIRouter(prefix="/v1/dreams", tags=["dreams"])


@router.post("", status_code=202, response_model=DreamOut)
async def request_dream(
    body: DreamIn, request: Request, ctx: CtxDep, idempotency_key: Annotated[str | None, Header()] = None
) -> JSONResponse:
    async def handler() -> DreamOut:
        job, _ = await dreaming_service.request_dream(
            ctx, body.workspace_id, body.mode, "manual", dedupe_window=body.dedupe_window
        )
        return DreamOut.model_validate(job)

    return await idempotency.run(ctx, idempotency_key, "POST", request.url.path, body.model_dump(), 202, handler)


@router.get("")
async def list_dreams(
    ctx: CtxDep,
    workspace_id: uuid.UUID,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: uuid.UUID | None = None,
) -> dict:
    return page(await dreaming_service.list_dreams(ctx, workspace_id, limit, cursor), limit, DreamOut)


@router.get("/{dream_id}", response_model=DreamOut)
async def get_dream(dream_id: uuid.UUID, ctx: CtxDep) -> DreamOut:
    return DreamOut.model_validate(await dreaming_service.get_dream(ctx, dream_id))

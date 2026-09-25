from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import JSONResponse

from app.api import idempotency
from app.api.deps import CtxDep
from app.modules import experience_service
from app.schemas.api import (
    EpisodeDetail,
    EpisodeOut,
    ExperienceCreated,
    ExperienceDetail,
    ExperienceIn,
    ExperienceOut,
    LearningStatus,
)
from app.schemas.common import page

router = APIRouter(prefix="/v1", tags=["experiences"])


@router.post("/experiences", status_code=201, response_model=ExperienceCreated)
async def create_experience(body: ExperienceIn, request: Request, ctx: CtxDep,
                            idempotency_key: Annotated[str | None, Header()] = None) -> JSONResponse:
    async def handler() -> ExperienceCreated:
        exp, job_id = await experience_service.create_experience(
            ctx, workspace_id=body.workspace_id, task=body.task, outcome=body.outcome,
            observation=body.observation, action=body.action, result=body.result, project_id=body.project_id,
            agent_id=body.agent_id, session_id=body.session_id, task_id=body.task_id,
            project_name=body.project_name, agent_name=body.agent_name, importance=body.importance,
            confidence=body.confidence, source=body.source, metadata=body.metadata)
        return ExperienceCreated(
            experience=ExperienceOut.model_validate(exp),
            learning=LearningStatus(job_id=str(job_id) if job_id else None, job_status="queued",
                                    processing_status=exp.processing_status, memories=[]),
        )

    return await idempotency.run(ctx, idempotency_key, "POST", request.url.path, body.model_dump(), 201, handler)


@router.get("/experiences")
async def list_experiences(ctx: CtxDep, workspace_id: uuid.UUID, project_id: uuid.UUID | None = None,
                           agent_id: uuid.UUID | None = None, outcome: str | None = None,
                           limit: Annotated[int, Query(ge=1, le=200)] = 50, cursor: uuid.UUID | None = None) -> dict:
    items = await experience_service.list_experiences(ctx, workspace_id=workspace_id, project_id=project_id,
                                                      agent_id=agent_id, outcome=outcome, limit=limit, cursor=cursor)
    return page(items, limit, ExperienceOut)


@router.get("/experiences/{experience_id}", response_model=ExperienceDetail)
async def get_experience(experience_id: uuid.UUID, ctx: CtxDep) -> ExperienceDetail:
    exp = await experience_service.get_experience(ctx, experience_id)
    learning = await experience_service.experience_learning(ctx, exp)
    return ExperienceDetail.model_validate({**ExperienceOut.model_validate(exp).model_dump(),
                                            "learning": LearningStatus(**learning)})


@router.get("/episodes")
async def list_episodes(ctx: CtxDep, workspace_id: uuid.UUID, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                        cursor: uuid.UUID | None = None) -> dict:
    items = await experience_service.list_episodes(ctx, workspace_id=workspace_id, limit=limit, cursor=cursor)
    return page(items, limit, EpisodeOut)


@router.get("/episodes/{episode_id}", response_model=EpisodeDetail)
async def get_episode(episode_id: uuid.UUID, ctx: CtxDep) -> EpisodeDetail:
    ep, exps = await experience_service.get_episode(ctx, episode_id)
    return EpisodeDetail.model_validate({**EpisodeOut.model_validate(ep).model_dump(),
                                         "experiences": [ExperienceOut.model_validate(e) for e in exps]})

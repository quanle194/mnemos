from __future__ import annotations

import hmac
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CtxDep, get_container, get_db
from app.api.errors import ApiError
from app.container import Container
from app.domain.permissions import ROLE_PERMISSIONS
from app.modules import tenancy_service
from app.schemas.api import (
    ApiKeyCreated,
    ApiKeyIn,
    ApiKeyOut,
    BootstrapIn,
    BootstrapOut,
    MeOut,
    NamedIn,
    WorkspaceIn,
)
from app.schemas.common import AgentOut, ProjectOut, WorkspaceOut

router = APIRouter(prefix="/v1", tags=["admin"])


@router.post("/admin/bootstrap", response_model=BootstrapOut, status_code=201)
async def bootstrap(
    body: BootstrapIn,
    container: Annotated[Container, Depends(get_container)],
    db: Annotated[AsyncSession, Depends(get_db)],
    x_bootstrap_secret: Annotated[str | None, Header()] = None,
) -> BootstrapOut:
    secret = container.settings.api_bootstrap_secret
    if not x_bootstrap_secret or not hmac.compare_digest(x_bootstrap_secret, secret):
        raise ApiError(401, "unauthorized", "invalid bootstrap secret")
    res = await tenancy_service.bootstrap(
        db, container.settings, organization_name=body.organization_name, workspace_name=body.workspace_name
    )
    await db.commit()
    return BootstrapOut(
        organization_id=res.organization.id,
        workspace_id=res.workspace.id,
        api_key=res.raw_key,
        api_key_id=res.api_key.id,
    )


@router.get("/me", response_model=MeOut)
async def me(ctx: CtxDep) -> MeOut:
    p = ctx.principal
    return MeOut(
        organization_id=p.organization_id,
        role=p.role.value,
        actor_id=p.actor_id,
        permissions=sorted(x.value for x in ROLE_PERMISSIONS[p.role]),
        workspace_ids=sorted(p.workspace_ids) if p.workspace_ids is not None else None,
    )


@router.post("/api-keys", response_model=ApiKeyCreated, status_code=201)
async def create_key(body: ApiKeyIn, ctx: CtxDep) -> ApiKeyCreated:
    key, raw = await tenancy_service.create_api_key(
        ctx, name=body.name, role=body.role, workspace_ids=body.workspace_ids
    )
    await ctx.commit()
    return ApiKeyCreated.model_validate({**ApiKeyOut.model_validate(key).model_dump(), "api_key": raw})


@router.get("/api-keys", response_model=list[ApiKeyOut])
async def list_keys(ctx: CtxDep) -> list[ApiKeyOut]:
    return [ApiKeyOut.model_validate(k) for k in await tenancy_service.list_api_keys(ctx)]


@router.delete("/api-keys/{key_id}", response_model=ApiKeyOut)
async def revoke_key(key_id: uuid.UUID, ctx: CtxDep) -> ApiKeyOut:
    key = await tenancy_service.revoke_api_key(ctx, key_id)
    await ctx.commit()
    return ApiKeyOut.model_validate(key)


@router.post("/workspaces", response_model=WorkspaceOut, status_code=201)
async def create_workspace(body: WorkspaceIn, ctx: CtxDep) -> WorkspaceOut:
    ws = await tenancy_service.create_workspace(ctx, body.name, body.settings_json)
    await ctx.commit()
    return WorkspaceOut.model_validate(ws)


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(ctx: CtxDep) -> list[WorkspaceOut]:
    return [WorkspaceOut.model_validate(w) for w in await tenancy_service.list_workspaces(ctx)]


@router.get("/workspaces/{workspace_id}", response_model=WorkspaceOut)
async def get_workspace(workspace_id: uuid.UUID, ctx: CtxDep) -> WorkspaceOut:
    return WorkspaceOut.model_validate(await tenancy_service.get_workspace(ctx, workspace_id))


@router.post("/workspaces/{workspace_id}/projects", response_model=ProjectOut, status_code=201)
async def create_project(workspace_id: uuid.UUID, body: NamedIn, ctx: CtxDep) -> ProjectOut:
    p = await tenancy_service.create_project(ctx, workspace_id, body.name)
    await ctx.commit()
    return ProjectOut.model_validate(p)


@router.get("/workspaces/{workspace_id}/projects", response_model=list[ProjectOut])
async def list_projects(workspace_id: uuid.UUID, ctx: CtxDep) -> list[ProjectOut]:
    return [ProjectOut.model_validate(p) for p in await tenancy_service.list_projects(ctx, workspace_id)]


@router.post("/workspaces/{workspace_id}/agents", response_model=AgentOut, status_code=201)
async def create_agent(workspace_id: uuid.UUID, body: NamedIn, ctx: CtxDep) -> AgentOut:
    a = await tenancy_service.create_agent(ctx, workspace_id, body.name, body.kind, body.metadata)
    await ctx.commit()
    return AgentOut.model_validate(a)


@router.get("/workspaces/{workspace_id}/agents", response_model=list[AgentOut])
async def list_agents(workspace_id: uuid.UUID, ctx: CtxDep) -> list[AgentOut]:
    return [AgentOut.model_validate(a) for a in await tenancy_service.list_agents(ctx, workspace_id)]

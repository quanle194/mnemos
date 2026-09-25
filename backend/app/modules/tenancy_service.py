"""Organizations, workspaces, projects, agents, sessions and API keys."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db.base import utcnow
from app.db.models import Agent, ApiKey, Organization, Project, Session, Workspace
from app.domain.enums import Role
from app.domain.permissions import Permission
from app.modules import audit
from app.modules.ctx import Ctx
from app.tenancy import AuthError, Conflict, NotFound, PermissionDenied, Principal, ValidationFailed

KEY_PREFIX = "mnm"


def hash_key(raw: str, pepper: bytes) -> str:
    return hmac.new(pepper, raw.encode(), hashlib.sha256).hexdigest()


def generate_key() -> tuple[str, str]:
    prefix = secrets.token_hex(4)
    secret = secrets.token_urlsafe(32).replace("-", "").replace("_", "")[:40]
    return prefix, f"{KEY_PREFIX}_{prefix}_{secret}"


async def resolve_api_key(db: AsyncSession, settings: Settings, raw: str, request_id: str | None) -> Principal:
    parts = raw.split("_")
    if len(parts) != 3 or parts[0] != KEY_PREFIX:
        raise AuthError("malformed API key")
    key = await db.scalar(select(ApiKey).where(ApiKey.prefix == parts[1]))
    if (
        key is None
        or key.revoked_at is not None
        or not hmac.compare_digest(key.key_hash, hash_key(raw, settings.pepper))
    ):
        raise AuthError("invalid API key")
    await db.execute(update(ApiKey).where(ApiKey.id == key.id).values(last_used_at=utcnow()))
    return Principal(
        organization_id=key.organization_id,
        role=Role(key.role),
        actor_type="api_key",
        actor_id=str(key.id),
        workspace_ids=frozenset(key.workspace_ids) if key.workspace_ids else None,
        request_id=request_id,
    )


@dataclass
class BootstrapResult:
    organization: Organization
    workspace: Workspace
    api_key: ApiKey
    raw_key: str


async def bootstrap(
    db: AsyncSession,
    settings: Settings,
    *,
    organization_name: str,
    workspace_name: str,
    key_name: str = "bootstrap-admin",
) -> BootstrapResult:
    org = Organization(name=organization_name)
    db.add(org)
    await db.flush()
    ws = Workspace(organization_id=org.id, name=workspace_name)
    db.add(ws)
    prefix, raw = generate_key()
    key = ApiKey(
        organization_id=org.id,
        name=key_name,
        prefix=prefix,
        key_hash=hash_key(raw, settings.pepper),
        role=Role.ADMIN.value,
    )
    db.add(key)
    await db.flush()
    ctx_principal = Principal.system(org.id, actor_id="bootstrap")
    from app.db.models import AuditLog

    db.add(
        AuditLog(
            organization_id=org.id,
            workspace_id=ws.id,
            actor_type=ctx_principal.actor_type,
            actor_id=ctx_principal.actor_id,
            action="organization.bootstrap",
            resource_type="organization",
            resource_id=str(org.id),
            after_json={"workspace": ws.name, "api_key": key.prefix},
        )
    )
    return BootstrapResult(org, ws, key, raw)


# ---------------------------------------------------------------- api keys
async def create_api_key(
    ctx: Ctx, *, name: str, role: Role, workspace_ids: list[uuid.UUID] | None
) -> tuple[ApiKey, str]:
    ctx.principal.require(Permission.WORKSPACE_MANAGE)
    if workspace_ids:
        for wid in workspace_ids:
            await get_workspace(ctx, wid)
    prefix, raw = generate_key()
    key = ApiKey(
        organization_id=ctx.principal.organization_id,
        name=name,
        prefix=prefix,
        key_hash=hash_key(raw, ctx.settings.pepper),
        role=role.value,
        workspace_ids=workspace_ids or None,
    )
    ctx.db.add(key)
    await ctx.db.flush()
    await audit.record(
        ctx, "api_key.create", "api_key", key.id, after={"name": name, "role": role.value, "prefix": prefix}
    )
    return key, raw


async def list_api_keys(ctx: Ctx) -> list[ApiKey]:
    ctx.principal.require(Permission.WORKSPACE_MANAGE)
    q = select(ApiKey).where(ApiKey.organization_id == ctx.principal.organization_id).order_by(ApiKey.created_at)
    return list((await ctx.db.scalars(q)).all())


async def revoke_api_key(ctx: Ctx, key_id: uuid.UUID) -> ApiKey:
    ctx.principal.require(Permission.WORKSPACE_MANAGE)
    key = await ctx.db.scalar(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.organization_id == ctx.principal.organization_id)
    )
    if key is None:
        raise NotFound("api key not found")
    if key.revoked_at is None:
        key.revoked_at = utcnow()
        await audit.record(ctx, "api_key.revoke", "api_key", key.id)
    return key


# ---------------------------------------------------------------- workspaces
async def create_workspace(ctx: Ctx, name: str, settings_json: dict | None = None) -> Workspace:
    ctx.principal.require(Permission.WORKSPACE_MANAGE)
    if ctx.principal.workspace_ids is not None:
        raise PermissionDenied("workspace-restricted keys cannot create workspaces")
    ws = Workspace(organization_id=ctx.principal.organization_id, name=name, settings_json=settings_json or {})
    ctx.db.add(ws)
    try:
        await ctx.db.flush()
    except IntegrityError as exc:
        raise Conflict("workspace name already exists") from exc
    await audit.record(ctx, "workspace.create", "workspace", ws.id, workspace_id=ws.id, after={"name": name})
    return ws


async def get_workspace(ctx: Ctx, workspace_id: uuid.UUID) -> Workspace:
    ws = await ctx.db.scalar(
        select(Workspace).where(
            Workspace.id == workspace_id, Workspace.organization_id == ctx.principal.organization_id
        )
    )
    if ws is None or not ctx.principal.can_access_workspace(ws.id):
        raise NotFound("workspace not found")
    return ws


async def list_workspaces(ctx: Ctx) -> list[Workspace]:
    q = select(Workspace).where(Workspace.organization_id == ctx.principal.organization_id)
    if ctx.principal.workspace_ids is not None:
        q = q.where(Workspace.id.in_(ctx.principal.workspace_ids))
    return list((await ctx.db.scalars(q.order_by(Workspace.created_at))).all())


# ---------------------------------------------------------------- projects / agents
async def create_project(ctx: Ctx, workspace_id: uuid.UUID, name: str) -> Project:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    ws = await get_workspace(ctx, workspace_id)
    existing = await ctx.db.scalar(select(Project).where(Project.workspace_id == ws.id, Project.name == name))
    if existing:
        return existing
    p = Project(organization_id=ws.organization_id, workspace_id=ws.id, name=name)
    ctx.db.add(p)
    await ctx.db.flush()
    await audit.record(ctx, "project.create", "project", p.id, workspace_id=ws.id, after={"name": name})
    return p


async def list_projects(ctx: Ctx, workspace_id: uuid.UUID) -> list[Project]:
    ws = await get_workspace(ctx, workspace_id)
    return list(
        (await ctx.db.scalars(select(Project).where(Project.workspace_id == ws.id).order_by(Project.created_at))).all()
    )


async def create_agent(
    ctx: Ctx, workspace_id: uuid.UUID, name: str, kind: str = "agent", metadata: dict | None = None
) -> Agent:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    ws = await get_workspace(ctx, workspace_id)
    existing = await ctx.db.scalar(select(Agent).where(Agent.workspace_id == ws.id, Agent.name == name))
    if existing:
        return existing
    a = Agent(
        organization_id=ws.organization_id, workspace_id=ws.id, name=name, kind=kind, metadata_json=metadata or {}
    )
    ctx.db.add(a)
    await ctx.db.flush()
    await audit.record(ctx, "agent.create", "agent", a.id, workspace_id=ws.id, after={"name": name})
    return a


async def list_agents(ctx: Ctx, workspace_id: uuid.UUID) -> list[Agent]:
    ws = await get_workspace(ctx, workspace_id)
    return list(
        (await ctx.db.scalars(select(Agent).where(Agent.workspace_id == ws.id).order_by(Agent.created_at))).all()
    )


async def lookup_ids(
    ctx: Ctx,
    workspace_id: uuid.UUID,
    *,
    project_id: uuid.UUID | None,
    project_name: str | None,
    agent_id: uuid.UUID | None,
    agent_name: str | None,
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    """Read-path name resolution (never creates entities). Unknown names -> 404."""
    ws = await get_workspace(ctx, workspace_id)
    if project_id is None and project_name:
        project_id = await ctx.db.scalar(
            select(Project.id).where(Project.workspace_id == ws.id, Project.name == project_name)
        )
        if project_id is None:
            raise NotFound(f"project '{project_name}' not found")
    if agent_id is None and agent_name:
        agent_id = await ctx.db.scalar(select(Agent.id).where(Agent.workspace_id == ws.id, Agent.name == agent_name))
        if agent_id is None:
            raise NotFound(f"agent '{agent_name}' not found")
    return project_id, agent_id


@dataclass
class Refs:
    workspace: Workspace
    project_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    session_id: uuid.UUID | None


async def resolve_refs(
    ctx: Ctx,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
    agent_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    project_name: str | None = None,
    agent_name: str | None = None,
    create_session: bool = False,
) -> Refs:
    """Validate that referenced project/agent/session belong to the workspace (tenant check)."""
    ws = await get_workspace(ctx, workspace_id)
    if project_id is None and project_name:
        project_id = (await create_project(ctx, ws.id, project_name)).id
    elif project_id is not None and not await ctx.db.scalar(
        select(Project.id).where(Project.id == project_id, Project.workspace_id == ws.id)
    ):
        raise NotFound("project not found")
    if agent_id is None and agent_name:
        agent_id = (await create_agent(ctx, ws.id, agent_name)).id
    elif agent_id is not None and not await ctx.db.scalar(
        select(Agent.id).where(Agent.id == agent_id, Agent.workspace_id == ws.id)
    ):
        raise NotFound("agent not found")
    if session_id is not None:
        if create_session:
            await ctx.db.execute(
                pg_insert(Session)
                .values(
                    id=session_id,
                    organization_id=ws.organization_id,
                    workspace_id=ws.id,
                    project_id=project_id,
                    agent_id=agent_id,
                )
                .on_conflict_do_nothing(index_elements=[Session.id])
            )
        sess = await ctx.db.scalar(select(Session).where(Session.id == session_id))
        if sess is None or sess.workspace_id != ws.id or sess.organization_id != ws.organization_id:
            raise NotFound("session not found")
    return Refs(ws, project_id, agent_id, session_id)


def ensure_text_limits(settings: Settings, **fields: str | None) -> None:
    for name, value in fields.items():
        if value and len(value) > settings.max_text_field_chars:
            raise ValidationFailed(f"{name} exceeds {settings.max_text_field_chars} characters")

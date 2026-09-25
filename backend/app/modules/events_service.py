"""L0 raw events (immutable) and L1 working memory (TTL)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.base import utcnow
from app.db.models import Event, WorkingMemory
from app.domain.enums import EventType
from app.domain.permissions import Permission
from app.domain.redaction import redact_text, redact_value
from app.modules import tenancy_service
from app.modules.ctx import Ctx
from app.tenancy import NotFound


async def record_events(ctx: Ctx, *, workspace_id: uuid.UUID, items: list[dict[str, Any]],
                        project_id: uuid.UUID | None = None, agent_id: uuid.UUID | None = None,
                        session_id: uuid.UUID | None = None, agent_name: str | None = None,
                        project_name: str | None = None) -> list[Event]:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    refs = await tenancy_service.resolve_refs(ctx, workspace_id=workspace_id, project_id=project_id,
                                              agent_id=agent_id, session_id=session_id, agent_name=agent_name,
                                              project_name=project_name, create_session=True)
    events = []
    for item in items:
        ev = Event(
            organization_id=refs.workspace.organization_id, workspace_id=refs.workspace.id,
            project_id=refs.project_id, agent_id=refs.agent_id, session_id=refs.session_id,
            task_id=item.get("task_id"), type=EventType(item["type"]).value,
            payload_json=redact_value(item.get("payload") or {}), occurred_at=item.get("occurred_at") or utcnow(),
        )
        ctx.db.add(ev)
        events.append(ev)
    await ctx.db.flush()
    return events


async def list_events(ctx: Ctx, *, workspace_id: uuid.UUID, session_id: uuid.UUID | None, task_id: str | None,
                      limit: int, cursor: uuid.UUID | None) -> list[Event]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    q = select(Event).where(Event.workspace_id == ws.id, Event.organization_id == ctx.principal.organization_id)
    if session_id:
        q = q.where(Event.session_id == session_id)
    if task_id:
        q = q.where(Event.task_id == task_id)
    if cursor:
        q = q.where(Event.id < cursor)
    return list((await ctx.db.scalars(q.order_by(Event.id.desc()).limit(limit))).all())


async def put_working_memory(ctx: Ctx, *, workspace_id: uuid.UUID, key: str, content: str,
                             agent_id: uuid.UUID | None, session_id: uuid.UUID | None, ttl_seconds: int,
                             importance: float) -> WorkingMemory:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    refs = await tenancy_service.resolve_refs(ctx, workspace_id=workspace_id, agent_id=agent_id,
                                              session_id=session_id, create_session=True)
    now = utcnow()
    stmt = (
        pg_insert(WorkingMemory)
        .values(organization_id=refs.workspace.organization_id, workspace_id=refs.workspace.id,
                agent_id=refs.agent_id, session_id=refs.session_id, key=key, content=redact_text(content),
                importance=importance, expires_at=now + timedelta(seconds=ttl_seconds), updated_at=now)
        .on_conflict_do_update(
            index_elements=["workspace_id", "agent_id", "session_id", "key"],
            set_={"content": redact_text(content), "importance": importance,
                  "expires_at": now + timedelta(seconds=ttl_seconds), "updated_at": now},
        )
        .returning(WorkingMemory.id)
    )
    wm_id = (await ctx.db.execute(stmt)).scalar_one()
    wm = await ctx.db.get(WorkingMemory, wm_id, populate_existing=True)
    assert wm is not None
    return wm


async def list_working_memory(ctx: Ctx, *, workspace_id: uuid.UUID, agent_id: uuid.UUID | None,
                              session_id: uuid.UUID | None, now: datetime | None = None) -> list[WorkingMemory]:
    ctx.principal.require(Permission.MEMORY_READ)
    ws = await tenancy_service.get_workspace(ctx, workspace_id)
    q = select(WorkingMemory).where(WorkingMemory.workspace_id == ws.id,
                                    WorkingMemory.organization_id == ctx.principal.organization_id,
                                    WorkingMemory.expires_at > (now or utcnow()))
    if agent_id:
        q = q.where(WorkingMemory.agent_id == agent_id)
    if session_id:
        q = q.where(WorkingMemory.session_id == session_id)
    return list((await ctx.db.scalars(q.order_by(WorkingMemory.importance.desc(), WorkingMemory.key))).all())


async def delete_working_memory(ctx: Ctx, wm_id: uuid.UUID) -> None:
    ctx.principal.require(Permission.EXPERIENCE_WRITE)
    wm = await ctx.db.get(WorkingMemory, wm_id)
    if wm is None or wm.organization_id != ctx.principal.organization_id or \
            not ctx.principal.can_access_workspace(wm.workspace_id):
        raise NotFound("working memory not found")
    await ctx.db.delete(wm)


async def purge_expired_working_memory(ctx: Ctx) -> int:
    res = await ctx.db.execute(delete(WorkingMemory).where(WorkingMemory.expires_at <= utcnow(),
                                                           WorkingMemory.organization_id ==
                                                           ctx.principal.organization_id))
    return int(res.rowcount or 0)  # type: ignore[attr-defined]

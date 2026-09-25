"""Audit log: every important state transition is recorded."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.db.models import AuditLog
from app.domain.redaction import redact_value
from app.modules.ctx import Ctx


async def record(ctx: Ctx, action: str, resource_type: str, resource_id: object | None, *,
                 workspace_id: uuid.UUID | None = None, before: dict[str, Any] | None = None,
                 after: dict[str, Any] | None = None) -> None:
    p = ctx.principal
    ctx.db.add(AuditLog(
        organization_id=p.organization_id, workspace_id=workspace_id, actor_type=p.actor_type, actor_id=p.actor_id,
        action=action, resource_type=resource_type, resource_id=str(resource_id) if resource_id else None,
        before_json=redact_value(before or {}), after_json=redact_value(after or {}), request_id=p.request_id,
    ))


async def list_logs(ctx: Ctx, *, workspace_id: uuid.UUID | None, resource_id: str | None, action: str | None,
                    limit: int, cursor: uuid.UUID | None) -> list[AuditLog]:
    q = select(AuditLog).where(AuditLog.organization_id == ctx.principal.organization_id)
    if ctx.principal.workspace_ids is not None:
        q = q.where(AuditLog.workspace_id.in_(ctx.principal.workspace_ids))
    if workspace_id:
        q = q.where(AuditLog.workspace_id == workspace_id)
    if resource_id:
        q = q.where(AuditLog.resource_id == resource_id)
    if action:
        q = q.where(AuditLog.action == action)
    if cursor:
        q = q.where(AuditLog.id < cursor)
    return list((await ctx.db.scalars(q.order_by(AuditLog.id.desc()).limit(limit))).all())

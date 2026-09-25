from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody


def page(items: list[Any], limit: int, model: type[BaseModel]) -> dict[str, Any]:
    out = [model.model_validate(i) for i in items]
    nxt = str(items[-1].id) if len(items) == limit and items else None
    return {"items": out, "next_cursor": nxt}


class WorkspaceOut(ORM):
    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    settings_json: dict[str, Any]
    created_at: datetime


class ProjectOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    created_at: datetime


class AgentOut(ORM):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    kind: str
    metadata_json: dict[str, Any]
    created_at: datetime

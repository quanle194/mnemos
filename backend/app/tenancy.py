"""Principal and tenant context passed to every service call."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from app.domain.enums import Role
from app.domain.permissions import ROLE_SOURCE_TRUST, Permission, has_permission


class AuthError(Exception):
    """401"""


class PermissionDenied(Exception):
    """403"""


class NotFound(Exception):
    """404 - also used for cross-tenant access so foreign IDs are not confirmable."""


class Conflict(Exception):
    """409"""

    def __init__(self, message: str, **details: object) -> None:
        super().__init__(message)
        self.details = details


class ValidationFailed(Exception):
    """422"""


@dataclass(frozen=True)
class Principal:
    organization_id: uuid.UUID
    role: Role
    actor_type: str  # api_key | system | admin_cli
    actor_id: str
    workspace_ids: frozenset[uuid.UUID] | None = None  # None = every workspace in the organization
    request_id: str | None = None
    extra: dict[str, str] = field(default_factory=dict)

    def can(self, permission: Permission) -> bool:
        return has_permission(self.role, permission)

    def require(self, permission: Permission) -> None:
        if not self.can(permission):
            raise PermissionDenied(f"missing permission {permission}")

    def can_access_workspace(self, workspace_id: uuid.UUID) -> bool:
        return self.workspace_ids is None or workspace_id in self.workspace_ids

    @property
    def source_trust(self) -> float:
        return ROLE_SOURCE_TRUST[self.role]

    @classmethod
    def system(cls, organization_id: uuid.UUID, actor_id: str = "worker") -> Principal:
        return cls(organization_id=organization_id, role=Role.ADMIN, actor_type="system", actor_id=actor_id)

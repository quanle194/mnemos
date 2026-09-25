"""RBAC baseline: roles -> permissions."""

from __future__ import annotations

from enum import StrEnum

from app.domain.enums import Role


class Permission(StrEnum):
    MEMORY_READ = "memory:read"
    EXPERIENCE_WRITE = "experience:write"
    MEMORY_PROPOSE = "memory:propose"
    FEEDBACK_WRITE = "feedback:write"
    MEMORY_REVIEW = "memory:review"
    DREAM_RUN = "dream:run"
    WORKSPACE_MANAGE = "workspace:manage"


_VIEWER = frozenset({Permission.MEMORY_READ})
_AGENT = _VIEWER | {Permission.EXPERIENCE_WRITE, Permission.MEMORY_PROPOSE, Permission.FEEDBACK_WRITE}
_MAINTAINER = _AGENT | {Permission.MEMORY_REVIEW, Permission.DREAM_RUN}
_ADMIN = _MAINTAINER | {Permission.WORKSPACE_MANAGE}

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: _VIEWER,
    Role.AGENT: frozenset(_AGENT),
    Role.MAINTAINER: frozenset(_MAINTAINER),
    Role.ADMIN: frozenset(_ADMIN),
}

# Base source trust granted to content created by a principal of the given role.
ROLE_SOURCE_TRUST: dict[Role, float] = {
    Role.ADMIN: 0.9,
    Role.MAINTAINER: 0.85,
    Role.AGENT: 0.6,
    Role.VIEWER: 0.3,
}


def has_permission(role: Role, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS[role]

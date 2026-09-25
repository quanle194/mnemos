from __future__ import annotations

from typing import Any


class MnemosError(Exception):
    """Raised for non-2xx API responses. Carries the structured error contract."""

    def __init__(
        self, status: int, code: str, message: str, details: dict[str, Any] | None = None, request_id: str | None = None
    ) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}
        self.request_id = request_id


class ConflictError(MnemosError):
    """HTTP 409, e.g. optimistic concurrency version mismatch (details.current_version)."""


class NotFoundError(MnemosError):
    pass


class AuthError(MnemosError):
    pass

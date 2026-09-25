"""Environment-driven configuration for the Mnemos MCP server."""

from __future__ import annotations

import ipaddress
import os
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

Transport = Literal["stdio", "streamable-http"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off", ""}


class ConfigError(ValueError):
    """Invalid or unsafe configuration."""


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise ConfigError(f"{name} must be a boolean (true/false), got {raw!r}")


def _optional(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name, "").strip()
    return value or None


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Settings:
    """Runtime settings. Build from the environment with :meth:`from_env`."""

    api_url: str = "http://localhost:8000"
    api_key: str | None = field(default=None, repr=False)
    workspace_id: str | None = None
    timeout: float = 30.0
    max_retries: int = 3
    transport: Transport = "stdio"
    host: str = "127.0.0.1"
    port: int = 8001
    http_path: str = "/mcp"
    token: str | None = field(default=None, repr=False)
    allow_unauthenticated: bool = False
    allowed_hosts: tuple[str, ...] = ()
    allowed_origins: tuple[str, ...] = ()
    stateless: bool = True
    log_level: LogLevel = "INFO"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        transport = env.get("MNEMOS_MCP_TRANSPORT", "stdio").strip().lower() or "stdio"
        if transport in {"http", "streamable_http"}:
            transport = "streamable-http"
        if transport not in ("stdio", "streamable-http"):
            raise ConfigError(f"MNEMOS_MCP_TRANSPORT must be 'stdio' or 'streamable-http', got {transport!r}")

        workspace_id = _optional(env, "MNEMOS_WORKSPACE_ID")
        if workspace_id is not None:
            try:
                workspace_id = str(uuid.UUID(workspace_id))
            except ValueError as exc:
                raise ConfigError(f"MNEMOS_WORKSPACE_ID must be a UUID, got {workspace_id!r}") from exc

        try:
            port = int(env.get("MNEMOS_MCP_PORT", "8001"))
            timeout = float(env.get("MNEMOS_TIMEOUT", "30"))
            max_retries = int(env.get("MNEMOS_MAX_RETRIES", "3"))
        except ValueError as exc:
            raise ConfigError(f"invalid numeric setting: {exc}") from exc
        if not 0 < port < 65536:
            raise ConfigError(f"MNEMOS_MCP_PORT out of range: {port}")

        http_path = env.get("MNEMOS_MCP_PATH", "/mcp").strip() or "/mcp"
        if not http_path.startswith("/"):
            http_path = "/" + http_path

        log_level = env.get("MNEMOS_MCP_LOG_LEVEL", "INFO").strip().upper()
        if log_level not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
            raise ConfigError(f"MNEMOS_MCP_LOG_LEVEL invalid: {log_level!r}")

        def _csv(name: str) -> tuple[str, ...]:
            return tuple(p.strip() for p in env.get(name, "").split(",") if p.strip())

        return cls(
            api_url=(_optional(env, "MNEMOS_URL") or "http://localhost:8000").rstrip("/"),
            api_key=_optional(env, "MNEMOS_API_KEY"),
            workspace_id=workspace_id,
            timeout=timeout,
            max_retries=max_retries,
            transport=transport,  # type: ignore[arg-type]  # validated above
            host=env.get("MNEMOS_MCP_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=port,
            http_path=http_path,
            token=_optional(env, "MNEMOS_MCP_TOKEN"),
            allow_unauthenticated=_bool(env, "MNEMOS_MCP_ALLOW_UNAUTHENTICATED", False),
            allowed_hosts=_csv("MNEMOS_MCP_ALLOWED_HOSTS"),
            allowed_origins=_csv("MNEMOS_MCP_ALLOWED_ORIGINS"),
            stateless=_bool(env, "MNEMOS_MCP_STATELESS", True),
            log_level=log_level,  # type: ignore[arg-type]  # validated above
        )

    def check_http_security(self) -> None:
        """Refuse to expose an unauthenticated HTTP transport beyond loopback unless explicitly allowed."""
        if self.transport != "streamable-http" or self.token or self.allow_unauthenticated:
            return
        if not is_loopback(self.host):
            raise ConfigError(
                f"refusing to serve MCP over HTTP on {self.host!r} without authentication: set MNEMOS_MCP_TOKEN "
                "(clients then send 'Authorization: Bearer <token>'), bind MNEMOS_MCP_HOST=127.0.0.1, or set "
                "MNEMOS_MCP_ALLOW_UNAUTHENTICATED=true only behind an authenticating proxy"
            )

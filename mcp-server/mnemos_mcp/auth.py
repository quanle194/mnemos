"""Static bearer-token guard for the streamable HTTP transport."""

from __future__ import annotations

import hmac
from collections.abc import Iterable

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class BearerTokenMiddleware:
    """Pure ASGI middleware requiring ``Authorization: Bearer <token>`` on every HTTP request.

    ``lifespan`` events pass through untouched; ``exempt_paths`` (e.g. ``/healthz``) are served without a token. When
    ``token`` is ``None`` the middleware is a no-op (use only on loopback or behind an authenticating proxy).
    """

    def __init__(self, app: ASGIApp, token: str | None, exempt_paths: Iterable[str] = ("/healthz",)) -> None:
        self.app = app
        self._token = token.encode() if token else None
        self._exempt = frozenset(exempt_paths)

    def _authorized(self, scope: Scope) -> bool:
        assert self._token is not None
        header = Headers(scope=scope).get("authorization", "")
        scheme, _, credential = header.partition(" ")
        if scheme.lower() != "bearer" or not credential.strip():
            return False
        return hmac.compare_digest(credential.strip().encode(), self._token)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self._token is None or scope["type"] == "lifespan" or scope.get("path") in self._exempt:
            await self.app(scope, receive, send)
            return
        if self._authorized(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        response = JSONResponse(
            {"error": {"code": "unauthorized", "message": "missing or invalid bearer token"}},
            status_code=401,
            headers={"WWW-Authenticate": 'Bearer realm="mnemos-mcp"'},
        )
        await response(scope, receive, send)

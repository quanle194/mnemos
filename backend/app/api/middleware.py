"""Request ID, structured access logs, metrics, body size limits."""

from __future__ import annotations

import re
import time
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.errors import error_response
from app.observability.logging import request_id_var
from app.observability.metrics import REQUEST_ERRORS, REQUEST_LATENCY

log = structlog.get_logger("mnemos.access")
_SAFE_RID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming = request.headers.get("x-request-id", "")
        rid = incoming if _SAFE_RID.match(incoming) else uuid.uuid4().hex
        token = request_id_var.set(rid)
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = rid
            return response
        finally:
            elapsed = time.perf_counter() - start
            route = request.scope.get("route")
            path = getattr(route, "path", "unmatched")
            REQUEST_LATENCY.labels(request.method, path, str(status)).observe(elapsed)
            if status >= 500:
                REQUEST_ERRORS.labels(path).inc()
            if not path.startswith("/health") and path != "/metrics":
                log.info("request", method=request.method, path=path, status=status,
                         duration_ms=round(elapsed * 1000, 2))
            request_id_var.reset(token)


class BodySizeLimitMiddleware:
    """Rejects bodies larger than max_bytes (checks Content-Length and streamed size)."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        length = headers.get(b"content-length")
        if length and length.isdigit() and int(length) > self.max_bytes:
            await error_response(413, "payload_too_large", f"body exceeds {self.max_bytes} bytes")(scope, receive, send)
            return
        received = 0

        async def limited_receive():  # type: ignore[no-untyped-def]
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _TooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _TooLarge:
            await error_response(413, "payload_too_large", f"body exceeds {self.max_bytes} bytes")(scope, receive, send)


class _TooLarge(Exception):  # noqa: N818
    pass

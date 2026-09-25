"""Minimal worker health/metrics HTTP endpoint (internal port, not published).

Implemented on asyncio streams instead of a full ASGI server so it never interferes with the worker's own
signal handling / graceful shutdown.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import TYPE_CHECKING

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text

from app.container import Container
from app.jobs import queue

if TYPE_CHECKING:
    from app.jobs.worker import Worker


async def _status(container: Container, worker: Worker, path: str) -> tuple[int, str, bytes]:
    if path == "/health/live":
        stalled = time.time() - worker.last_tick > max(120, container.settings.job_lease_seconds * 2)
        body_live = {
            "status": "stalled" if stalled else "ok",
            "worker_id": worker.worker_id,
            "processed": worker.processed,
        }
        return (503 if stalled else 200), "application/json", json.dumps(body_live).encode()
    if path == "/health/ready":
        try:
            async with container.sessions() as s:
                await s.execute(text("SELECT 1"))
                depth = await queue.depth(s)
            db_ok = True
        except Exception:
            db_ok, depth = False, {}
        redis_ok = await container.redis.ping()
        ok = db_ok and redis_ok
        body: dict[str, object] = {
            "status": "ok" if ok else "unavailable",
            "database": db_ok,
            "redis": redis_ok,
            "queue": depth,
            "worker_id": worker.worker_id,
        }
        return (200 if ok else 503), "application/json", json.dumps(body).encode()
    if path == "/metrics":
        return 200, CONTENT_TYPE_LATEST, generate_latest()
    return 404, "application/json", b'{"status":"not_found"}'


async def serve_health(container: Container, worker: Worker, host: str, port: int) -> None:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            parts = line.decode(errors="replace").split()
            path = parts[1].split("?")[0] if len(parts) >= 2 else "/"
            while (await asyncio.wait_for(reader.readline(), timeout=5)) not in (b"\r\n", b"\n", b""):
                pass
            status, ctype, body = await _status(container, worker, path)
            reason = {200: "OK", 404: "Not Found", 503: "Service Unavailable"}[status]
            writer.write(
                f"HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                f"Connection: close\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        except (TimeoutError, ConnectionError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    server = await asyncio.start_server(handle, host, port)
    async with server:
        await server.serve_forever()

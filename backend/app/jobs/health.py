"""Worker health/metrics endpoint (internal port, not published)."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from app.container import Container
from app.jobs import queue

if TYPE_CHECKING:
    from app.jobs.worker import Worker


def build_health_app(container: Container, worker: Worker) -> Starlette:
    async def live(_: Request) -> JSONResponse:
        stalled = time.time() - worker.last_tick > max(120, container.settings.job_lease_seconds * 2)
        return JSONResponse({"status": "stalled" if stalled else "ok", "worker_id": worker.worker_id,
                             "processed": worker.processed}, status_code=503 if stalled else 200)

    async def ready(_: Request) -> JSONResponse:
        try:
            async with container.sessions() as s:
                await s.execute(text("SELECT 1"))
                depth = await queue.depth(s)
            db_ok = True
        except Exception:
            db_ok, depth = False, {}
        redis_ok = await container.redis.ping()
        ok = db_ok and redis_ok
        return JSONResponse({"status": "ok" if ok else "unavailable", "database": db_ok, "redis": redis_ok,
                             "queue": depth, "worker_id": worker.worker_id}, status_code=200 if ok else 503)

    async def metrics(_: Request) -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return Starlette(routes=[Route("/health/live", live), Route("/health/ready", ready), Route("/metrics", metrics)])

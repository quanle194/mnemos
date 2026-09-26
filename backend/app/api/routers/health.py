from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text

from app.api.deps import get_container
from app.container import Container
from app.jobs import queue
from app.observability.metrics import QUEUE_DEPTH

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(container: Annotated[Container, Depends(get_container)]) -> JSONResponse:
    checks: dict[str, Any] = {}
    ok = True
    try:
        async with container.sessions() as s:
            await s.execute(text("SELECT 1"))
            ext = await s.scalar(text("SELECT extversion FROM pg_extension WHERE extname = 'vector'"))
            rev = await s.scalar(text("SELECT version_num FROM alembic_version"))
            depth = await queue.depth(s)
        checks["database"] = {"ok": True, "pgvector": ext, "migration": rev}
        checks["queue"] = depth
        for status, n in depth.items():
            QUEUE_DEPTH.labels(status=status).set(n)
    except Exception as exc:  # readiness must never raise
        ok = False
        checks["database"] = {"ok": False, "error": type(exc).__name__}
    redis_ok = await container.redis.ping()
    checks["redis"] = {"ok": redis_ok}
    ok = ok and redis_ok
    checks["workers"] = await container.redis.live_workers()
    checks["providers"] = {
        "llm": container.llm.name,
        "embedding": container.embedder.name,
        "embedding_dimensions": container.embedder.dimensions,
    }
    return JSONResponse({"status": "ok" if ok else "unavailable", "checks": checks}, status_code=200 if ok else 503)


@router.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

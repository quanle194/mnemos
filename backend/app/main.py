"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from app.api import errors
from app.api.middleware import BodySizeLimitMiddleware, RequestContextMiddleware
from app.api.routers import admin, conflicts, context, dreams, events, experiences, health, memories, ops
from app.config import Settings, get_settings
from app.container import Container
from app.observability.logging import configure_logging


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json, "mnemos-api")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.container = container or Container.build(settings)
        try:
            yield
        finally:
            if container is None:
                await app.state.container.aclose()

    app = FastAPI(
        title="Mnemos API",
        version="0.1.0",
        description="Governed long-term memory and continuous learning for AI agents.",
        lifespan=lifespan,
    )
    errors.install(app)
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                           allow_methods=["*"], allow_headers=["*"], expose_headers=["ETag", "X-Request-ID"])
    hosts = [h.strip() for h in settings.allowed_hosts.split(",") if h.strip()]
    if hosts and hosts != ["*"]:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_request_bytes)
    for r in (health, admin, events, experiences, memories, context, conflicts, dreams, ops):
        app.include_router(r.router)
    return app


def app_factory() -> FastAPI:
    return create_app()

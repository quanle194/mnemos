"""FastAPI dependencies: container, DB session, principal, per-request Ctx, rate limiting."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import ApiError
from app.container import Container
from app.modules import tenancy_service
from app.modules.ctx import Ctx
from app.observability.logging import request_id_var
from app.tenancy import AuthError


def get_container(request: Request) -> Container:
    return request.app.state.container  # type: ignore[no-any-return]


async def get_db(container: Annotated[Container, Depends(get_container)]) -> AsyncIterator[AsyncSession]:
    async with container.sessions() as session:
        try:
            yield session
        finally:
            if session.in_transaction():
                await session.rollback()


def _extract_key(authorization: str | None, x_api_key: str | None) -> str:
    if x_api_key:
        return x_api_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    raise AuthError("missing API key (Authorization: Bearer <key> or X-API-Key)")


async def get_ctx(
    container: Annotated[Container, Depends(get_container)],
    db: Annotated[AsyncSession, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header()] = None,
) -> Ctx:
    raw = _extract_key(authorization, x_api_key)
    principal = await tenancy_service.resolve_api_key(db, container.settings, raw, request_id_var.get())
    allowed, _remaining = await container.redis.rate_limit(principal.actor_id, container.settings.rate_limit_per_minute)
    if not allowed:
        raise ApiError(
            429,
            "rate_limited",
            "rate limit exceeded",
            {"limit_per_minute": container.settings.rate_limit_per_minute},
            headers={"Retry-After": "60"},
        )
    await db.commit()  # persist last_used_at; subsequent work runs in a fresh transaction
    return Ctx(db=db, principal=principal, container=container)


CtxDep = Annotated[Ctx, Depends(get_ctx)]

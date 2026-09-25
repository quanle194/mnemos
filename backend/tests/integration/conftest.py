"""Integration fixtures: real PostgreSQL + pgvector + Redis, fake LLM/embedding providers."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import httpx
import pytest
from alembic import command
from alembic.config import Config

from app.config import Settings
from app.container import Container
from app.jobs.worker import Worker
from app.main import create_app

pytestmark = pytest.mark.integration

ADMIN_DSN = os.environ.get("MNEMOS_TEST_ADMIN_DSN", "postgresql://mnemos:mnemos@127.0.0.1:55432/postgres")
TEST_DB = os.environ.get("MNEMOS_TEST_DB_NAME", "mnemos_test")
REDIS_URL = os.environ.get("MNEMOS_TEST_REDIS_URL", "redis://127.0.0.1:56379/15")
BOOTSTRAP_SECRET = "test-bootstrap-secret-0123456789"


def _db_url() -> str:
    base = ADMIN_DSN.rsplit("/", 1)[0].replace("postgresql://", "postgresql+asyncpg://")
    return f"{base}/{TEST_DB}"


async def _recreate_db() -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{TEST_DB}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        app_env="test",
        database_url=_db_url(),
        redis_url=REDIS_URL,
        api_bootstrap_secret=BOOTSTRAP_SECRET,
        log_json=False,
        log_level="WARNING",
        rate_limit_per_minute=100_000,
        scheduler_enabled=False,
    )


@pytest.fixture(scope="session")
def migrated(settings: Settings) -> str:
    asyncio.run(_recreate_db())
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "..", "alembic.ini"))
    cfg.attributes["database_url"] = settings.database_url
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
    return settings.database_url


@pytest.fixture(scope="session")
async def container(settings: Settings, migrated: str) -> AsyncIterator[Container]:
    c = Container.build(settings)
    await c.redis.client.flushdb()
    yield c
    await c.aclose()


@pytest.fixture(scope="session")
def app(settings: Settings, container: Container):  # type: ignore[no-untyped-def]
    application = create_app(settings, container)
    application.state.container = container
    return application


@pytest.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:  # type: ignore[no-untyped-def]
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def worker(container: Container) -> Worker:
    return Worker(container, f"test-{uuid.uuid4().hex[:6]}")


class Tenant:
    def __init__(self, client: httpx.AsyncClient, data: dict[str, Any]) -> None:
        self.client = client
        self.org_id: str = data["organization_id"]
        self.workspace_id: str = data["workspace_id"]
        self.key: str = data["api_key"]
        self.headers = {"Authorization": f"Bearer {self.key}"}

    async def req(self, method: str, path: str, *, key: str | None = None, **kw: Any) -> httpx.Response:
        headers = {"Authorization": f"Bearer {key or self.key}", **kw.pop("headers", {})}
        return await self.client.request(method, path, headers=headers, **kw)

    async def ok(self, method: str, path: str, **kw: Any) -> Any:
        r = await self.req(method, path, **kw)
        assert r.status_code < 300, f"{method} {path} -> {r.status_code}: {r.text}"
        return r.json() if r.content else None

    async def make_key(self, role: str, workspace_ids: list[str] | None = None) -> str:
        body: dict[str, Any] = {"name": f"{role}-{uuid.uuid4().hex[:4]}", "role": role}
        if workspace_ids:
            body["workspace_ids"] = workspace_ids
        return (await self.ok("POST", "/v1/api-keys", json=body))["api_key"]


async def bootstrap_tenant(client: httpx.AsyncClient, name: str | None = None) -> Tenant:
    r = await client.post(
        "/v1/admin/bootstrap",
        json={"organization_name": name or f"org-{uuid.uuid4().hex[:6]}", "workspace_name": "main"},
        headers={"X-Bootstrap-Secret": BOOTSTRAP_SECRET},
    )
    assert r.status_code == 201, r.text
    return Tenant(client, r.json())


@pytest.fixture
async def tenant(client: httpx.AsyncClient) -> Tenant:
    return await bootstrap_tenant(client)


@pytest.fixture
async def tenant_b(client: httpx.AsyncClient) -> Tenant:
    return await bootstrap_tenant(client)

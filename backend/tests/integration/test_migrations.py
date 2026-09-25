"""Migrations work on a clean database: upgrade -> downgrade -> upgrade, and models match the schema."""

from __future__ import annotations

import asyncio
import os

import asyncpg
import pytest
from alembic import command
from alembic.config import Config

from app.db.base import Base
from tests.integration.conftest import ADMIN_DSN

pytestmark = pytest.mark.integration
DB = "mnemos_migration_test"


async def _recreate() -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{DB}"')
    finally:
        await conn.close()


def test_upgrade_downgrade_roundtrip_and_no_drift() -> None:
    asyncio.run(_recreate())
    base = ADMIN_DSN.rsplit("/", 1)[0]
    url = base.replace("postgresql://", "postgresql+asyncpg://") + f"/{DB}"
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "..", "alembic.ini"))
    cfg.attributes["database_url"] = url
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    async def tables() -> set[str]:
        conn = await asyncpg.connect(base + f"/{DB}")
        try:
            rows = await conn.fetch("SELECT tablename FROM pg_tables WHERE schemaname='public'")
            return {r["tablename"] for r in rows}
        finally:
            await conn.close()

    assert set(Base.metadata.tables) <= asyncio.run(tables())
    command.check(cfg)  # raises if ORM models and migrated schema drift apart

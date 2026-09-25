"""Per-unit-of-work context: DB session + principal + container dependencies."""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.container import Container
from app.tenancy import Principal


@dataclass
class Ctx:
    db: AsyncSession
    principal: Principal
    container: Container
    wake_workers: bool = field(default=False)

    @property
    def settings(self) -> Settings:
        return self.container.settings

    async def commit(self) -> None:
        await self.db.commit()
        if self.wake_workers:
            self.wake_workers = False
            await self.container.redis.wake_workers()

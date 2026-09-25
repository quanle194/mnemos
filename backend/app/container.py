"""Explicit dependency container (no hidden global provider state)."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.config import Settings
from app.db.session import create_engine, create_session_factory
from app.providers.base import EmbeddingProvider, LLMProvider
from app.providers.factory import build_embedder, build_llm
from app.redis_client import RedisFacade


@dataclass
class Container:
    settings: Settings
    engine: AsyncEngine
    sessions: async_sessionmaker[AsyncSession]
    redis: RedisFacade
    llm: LLMProvider
    embedder: EmbeddingProvider

    @classmethod
    def build(
        cls, settings: Settings, *, llm: LLMProvider | None = None, embedder: EmbeddingProvider | None = None
    ) -> Container:
        engine = create_engine(settings)
        embedder = embedder or build_embedder(settings)
        if embedder.dimensions != settings.embedding_dimensions:
            raise ValueError("embedding provider dimension mismatch with EMBEDDING_DIMENSIONS")
        return cls(
            settings=settings,
            engine=engine,
            sessions=create_session_factory(engine),
            redis=RedisFacade(settings.redis_url),
            llm=llm or build_llm(settings),
            embedder=embedder,
        )

    async def aclose(self) -> None:
        await self.llm.aclose()
        await self.embedder.aclose()
        await self.redis.aclose()
        await self.engine.dispose()

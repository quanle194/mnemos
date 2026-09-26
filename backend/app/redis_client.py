"""Redis helpers: wake-up signals, rate limiting, locks, heartbeats. All are best-effort (fail open)."""

from __future__ import annotations

import contextlib
import time

import redis.asyncio as aioredis
import structlog
from redis.exceptions import RedisError

log = structlog.get_logger(__name__)
WAKE_KEY = "mnemos:jobs:wake"


class RedisFacade:
    def __init__(self, url: str) -> None:
        self.client: aioredis.Redis = aioredis.from_url(
            url, decode_responses=True, socket_timeout=5, socket_connect_timeout=3
        )

    async def ping(self) -> bool:
        try:
            return bool(await self.client.ping())
        except (RedisError, OSError):
            return False

    async def wake_workers(self) -> None:
        try:
            pipe = self.client.pipeline()
            pipe.lpush(WAKE_KEY, "1")
            pipe.ltrim(WAKE_KEY, 0, 100)
            await pipe.execute()
        except (RedisError, OSError) as exc:
            log.warning("redis_wake_failed", error=str(exc))

    async def wait_for_wake(self, wait_seconds: float) -> None:
        try:
            await self.client.brpop([WAKE_KEY], timeout=max(1, int(wait_seconds)))
        except (RedisError, OSError):
            import asyncio

            await asyncio.sleep(wait_seconds)

    async def rate_limit(self, key: str, limit: int, window_seconds: int = 60) -> tuple[bool, int]:
        """Fixed-window counter. Returns (allowed, remaining). Fails open if Redis is unavailable."""
        bucket = f"mnemos:rl:{key}:{int(time.time() // window_seconds)}"
        try:
            pipe = self.client.pipeline()
            pipe.incr(bucket)
            pipe.expire(bucket, window_seconds + 5)
            count, _ = await pipe.execute()
        except (RedisError, OSError):
            return True, limit
        return int(count) <= limit, max(0, limit - int(count))

    async def try_lock(self, name: str, owner: str, ttl_seconds: int) -> bool:
        try:
            ok = await self.client.set(f"mnemos:lock:{name}", owner, nx=True, ex=ttl_seconds)
            if ok:
                return True
            current = await self.client.get(f"mnemos:lock:{name}")
            if current == owner:
                await self.client.expire(f"mnemos:lock:{name}", ttl_seconds)
                return True
            return False
        except (RedisError, OSError):
            return False

    async def heartbeat(self, worker_id: str, ttl_seconds: int = 30) -> None:
        with contextlib.suppress(RedisError, OSError):
            await self.client.set(f"mnemos:worker:{worker_id}", str(time.time()), ex=ttl_seconds)

    async def live_workers(self) -> list[str]:
        try:
            keys = [k async for k in self.client.scan_iter("mnemos:worker:*")]
        except (RedisError, OSError):
            return []
        return [k.split(":", 2)[2] for k in keys]

    async def aclose(self) -> None:
        await self.client.aclose()

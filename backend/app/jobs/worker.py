"""Background worker: leases jobs from PostgreSQL, retries with backoff, dead-letters, runs the scheduler."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import time
import uuid

import structlog
from sqlalchemy import select

from app.container import Container
from app.db.base import utcnow
from app.db.models import Organization, Workspace
from app.jobs import handlers, queue
from app.modules import dreaming_service
from app.modules.ctx import Ctx
from app.observability.logging import job_id_var
from app.observability.metrics import JOB_RETRIES, JOBS_DEAD, JOBS_PROCESSED, QUEUE_DEPTH
from app.tenancy import Principal

log = structlog.get_logger("mnemos.worker")


class Worker:
    def __init__(self, container: Container, worker_id: str | None = None) -> None:
        self.container = container
        self.settings = container.settings
        self.worker_id = worker_id or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.stop = asyncio.Event()
        self.processed = 0
        self.last_tick = time.time()

    async def process_one(self) -> bool:
        """Claim and execute at most one job. Returns True if a job was processed."""
        async with self.container.sessions() as db:
            job = await queue.claim(db, self.worker_id, self.settings.job_lease_seconds)
        if job is None:
            return False
        token = job_id_var.set(str(job.id))
        renew = asyncio.create_task(self._renew_lease(job.id))
        started = time.perf_counter()
        try:
            if job.attempts > job.max_attempts:
                raise RuntimeError("attempts exhausted (previous executions crashed)")
            result = await handlers.dispatch(self.container, job)
            async with self.container.sessions() as db:
                await queue.complete(db, job.id, self.worker_id, result or {})
            JOBS_PROCESSED.labels(kind=job.kind, outcome="succeeded").inc()
            log.info("job_succeeded", kind=job.kind, attempts=job.attempts,
                     duration_ms=round((time.perf_counter() - started) * 1000, 1))
        except Exception as exc:
            async with self.container.sessions() as db:
                status = await queue.fail(db, job, self.worker_id, f"{type(exc).__name__}: {exc}")
            JOBS_PROCESSED.labels(kind=job.kind, outcome=status).inc()
            if status == "dead":
                JOBS_DEAD.labels(kind=job.kind).inc()
                log.error("job_dead", kind=job.kind, attempts=job.attempts, error=str(exc), exc_info=True)
            else:
                JOB_RETRIES.labels(kind=job.kind).inc()
                log.warning("job_failed_will_retry", kind=job.kind, attempts=job.attempts, error=str(exc))
        finally:
            renew.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renew
            job_id_var.reset(token)
            self.processed += 1
        return True

    async def _renew_lease(self, job_id: uuid.UUID) -> None:
        interval = max(5, self.settings.job_lease_seconds // 3)
        while True:
            await asyncio.sleep(interval)
            async with self.container.sessions() as db:
                await queue.extend_lease(db, job_id, self.worker_id, self.settings.job_lease_seconds)

    async def drain(self, max_jobs: int = 10_000) -> int:
        """Process jobs until the queue is empty (used by tests, CLI and evals)."""
        n = 0
        while n < max_jobs and await self.process_one():
            n += 1
        return n

    async def _slot(self, idx: int) -> None:
        while not self.stop.is_set():
            try:
                did = await self.process_one()
            except Exception as exc:  # database outage etc.: back off, never crash the worker
                log.error("worker_loop_error", slot=idx, error=str(exc))
                did = False
                await asyncio.sleep(2)
            self.last_tick = time.time()
            if not did:
                await self.container.redis.wait_for_wake(self.settings.worker_poll_seconds)

    async def _scheduler(self) -> None:
        while not self.stop.is_set():
            try:
                await self.container.redis.heartbeat(self.worker_id)
                if self.settings.scheduler_enabled and await self.container.redis.try_lock(
                        "scheduler", self.worker_id, ttl_seconds=60):
                    await self.schedule_once()
                async with self.container.sessions() as db:
                    for status, n in (await queue.depth(db)).items():
                        QUEUE_DEPTH.labels(status=status).set(n)
            except Exception as exc:
                log.error("scheduler_error", error=str(exc))
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stop.wait(), timeout=15)

    async def schedule_once(self) -> dict[str, int]:
        s = self.settings
        bucket = int(utcnow().timestamp() // (s.lifecycle_interval_minutes * 60))
        created = 0
        async with self.container.sessions() as db:
            if await queue.enqueue(db, kind=queue.LIFECYCLE_SWEEP, payload={}, idempotency_key=f"lifecycle:{bucket}",
                                   organization_id=None, max_attempts=3):
                created += 1
            await db.commit()
            workspaces = (await db.execute(select(Workspace.id, Workspace.organization_id)
                                           .join(Organization, Organization.id == Workspace.organization_id))).all()
        for ws_id, org_id in workspaces:
            async with self.container.sessions() as db:
                ctx = Ctx(db=db, principal=Principal.system(org_id, "scheduler"), container=self.container)
                ws = await db.get(Workspace, ws_id)
                assert ws is not None
                created += len(await dreaming_service.schedule_workspace(ctx, ws))
                await ctx.commit()
        if created:
            await self.container.redis.wake_workers()
        return {"jobs_created": created}

    async def run(self) -> None:
        log.info("worker_start", worker_id=self.worker_id, concurrency=self.settings.worker_concurrency)
        tasks = [asyncio.create_task(self._slot(i)) for i in range(self.settings.worker_concurrency)]
        tasks.append(asyncio.create_task(self._scheduler()))
        await self.stop.wait()
        log.info("worker_stopping", worker_id=self.worker_id)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def run_worker(container: Container, health_port: int | None = None) -> None:
    worker = Worker(container)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.stop.set)
    server_task = None
    if health_port:
        import uvicorn

        from app.jobs.health import build_health_app

        config = uvicorn.Config(build_health_app(container, worker), host="0.0.0.0", port=health_port,  # noqa: S104
                                log_level="warning", lifespan="off")
        server = uvicorn.Server(config)
        server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
        server_task = asyncio.create_task(server.serve())
    try:
        await worker.run()
    finally:
        if server_task:
            server_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await server_task

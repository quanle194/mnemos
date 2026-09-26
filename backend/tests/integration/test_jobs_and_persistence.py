"""Scenario 10 (in-process part): jobs survive worker crashes/restarts; retries, dead letters, readiness,
L0 immutability, L1 TTL, pagination."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, text, update

from app.config import Settings
from app.container import Container
from app.db.base import utcnow
from app.db.models import Job
from app.jobs import queue
from app.jobs.worker import Worker
from app.providers.fake import FakeLLMProvider
from tests.integration.conftest import Tenant

pytestmark = pytest.mark.integration


async def test_crashed_worker_lease_is_reclaimed(tenant: Tenant, container: Container, settings: Settings) -> None:
    created = await tenant.ok(
        "POST",
        "/v1/experiences",
        json={
            "workspace_id": tenant.workspace_id,
            "task": "Crash recovery task",
            "outcome": "success",
            "observation": "Worker died mid-job during the crash recovery drill.",
            "action": "restart worker",
            "result": "job completed after restart",
        },
    )
    job_id = uuid.UUID(created["learning"]["job_id"])
    # worker 1 claims the job and "crashes" (never completes)
    async with container.sessions() as db:
        claimed = None
        for _ in range(50):
            j = await queue.claim(db, "crashed-worker", lease_seconds=60)
            if j is None:
                break
            if j.id == job_id:
                claimed = j
                break
            await queue.complete(db, j.id, "crashed-worker", {})  # unrelated leftovers
        assert claimed is not None and claimed.status == "running"
        await db.execute(update(Job).where(Job.id == job_id).values(locked_until=utcnow() - timedelta(seconds=1)))
        await db.commit()
    # a brand-new container (simulated process restart) picks up the expired lease and completes it
    fresh = Container.build(settings)
    try:
        await Worker(fresh, "restarted-worker").drain()
        async with fresh.sessions() as db:
            job = await db.get(Job, job_id)
            assert job is not None and job.status == "succeeded" and job.attempts == 2
            assert job.locked_by == "restarted-worker"
    finally:
        await fresh.aclose()
    detail = await tenant.ok("GET", f"/v1/experiences/{created['experience']['id']}")
    assert detail["processing_status"] == "processed" and detail["learning"]["memories"]


class FlakyLLM(FakeLLMProvider):
    def __init__(self, failures: int) -> None:
        super().__init__()
        self.failures = failures

    async def generate_json(self, task, payload):  # type: ignore[no-untyped-def]
        if task == "memory_extraction" and self.failures > 0:
            self.failures -= 1
            from app.providers.base import ProviderError

            raise ProviderError("simulated provider outage")
        return await super().generate_json(task, payload)


async def test_retry_then_success_and_dead_letter(tenant: Tenant, settings: Settings) -> None:
    flaky = Container.build(settings.model_copy(update={"job_max_attempts": 3}), llm=FlakyLLM(failures=1))
    try:
        created = await tenant.ok(
            "POST",
            "/v1/experiences",
            json={
                "workspace_id": tenant.workspace_id,
                "task": "Provider outage task",
                "outcome": "success",
                "observation": "LLM provider returned 503 during extraction of this experience.",
                "action": "retry with backoff",
                "result": "succeeded later",
            },
        )
        job_id = uuid.UUID(created["learning"]["job_id"])
        w = Worker(flaky, "flaky")
        await w.drain()
        async with flaky.sessions() as db:
            job = await db.get(Job, job_id)
            assert job is not None and job.status == "failed" and "simulated provider outage" in job.last_error
            # no partial state was written by the failed attempt
            n = await db.scalar(
                text("SELECT count(*) FROM memory_evidence WHERE source_id = :s"), {"s": created["experience"]["id"]}
            )
            assert n == 0
            await db.execute(update(Job).where(Job.id == job_id).values(run_after=utcnow()))
            await db.commit()
        await w.drain()
        async with flaky.sessions() as db:
            job = await db.get(Job, job_id, populate_existing=True)
            assert job is not None and job.status == "succeeded" and job.attempts == 2
    finally:
        await flaky.aclose()

    dead = Container.build(settings.model_copy(update={"job_max_attempts": 2}), llm=FlakyLLM(failures=99))
    try:
        created = await tenant.ok(
            "POST",
            "/v1/experiences",
            json={
                "workspace_id": tenant.workspace_id,
                "task": "Always failing",
                "outcome": "failure",
                "observation": "This experience extraction will always fail in the test.",
                "action": "x",
                "result": "y",
            },
        )
        job_id = uuid.UUID(created["learning"]["job_id"])
        async with dead.sessions() as db:
            await db.execute(update(Job).where(Job.id == job_id).values(max_attempts=2))
            await db.commit()
        w = Worker(dead, "dead")
        for _ in range(3):
            await w.drain()
            async with dead.sessions() as db:
                await db.execute(update(Job).where(Job.id == job_id, Job.status == "failed").values(run_after=utcnow()))
                await db.commit()
        async with dead.sessions() as db:
            job = await db.get(Job, job_id)
            assert job is not None and job.status == "dead" and job.attempts == 2
        jobs = await tenant.ok("GET", "/v1/jobs?status=dead")
        assert any(j["id"] == str(job_id) for j in jobs["items"])
        await tenant.ok("POST", f"/v1/jobs/{job_id}/retry")
        async with dead.sessions() as db:
            assert (await db.get(Job, job_id, populate_existing=True)).status == "queued"  # type: ignore[union-attr]
    finally:
        await dead.aclose()


async def test_enqueue_is_idempotent(container: Container) -> None:
    async with container.sessions() as db:
        key = f"test:{uuid.uuid4()}"
        a = await queue.enqueue(db, kind=queue.LIFECYCLE_SWEEP, payload={}, idempotency_key=key, organization_id=None)
        b = await queue.enqueue(db, kind=queue.LIFECYCLE_SWEEP, payload={}, idempotency_key=key, organization_id=None)
        await db.commit()
        assert a is not None and b is None
        assert len((await db.scalars(select(Job).where(Job.idempotency_key == key))).all()) == 1


async def test_events_are_immutable_and_working_memory_expires(tenant: Tenant, container: Container) -> None:
    sid = str(uuid.uuid4())
    res = await tenant.ok(
        "POST",
        "/v1/events",
        json={
            "workspace_id": tenant.workspace_id,
            "session_id": sid,
            "agent_name": "ev-agent",
            "events": [
                {"type": "user", "payload": {"text": "hello"}, "task_id": "t"},
                {"type": "tool", "payload": {"tool": "shell", "exit_code": 1}, "task_id": "t"},
                {"type": "error", "payload": {"message": "boom"}, "task_id": "t"},
            ],
        },
    )
    assert len(res["items"]) == 3
    listed = await tenant.ok("GET", f"/v1/events?workspace_id={tenant.workspace_id}&session_id={sid}&limit=2")
    assert len(listed["items"]) == 2 and listed["next_cursor"]
    rest = await tenant.ok(
        "GET", f"/v1/events?workspace_id={tenant.workspace_id}&session_id={sid}&limit=2&cursor={listed['next_cursor']}"
    )
    assert len(rest["items"]) == 1
    async with container.sessions() as db:
        with pytest.raises(Exception, match="append-only"):
            await db.execute(text("UPDATE events SET type = 'user' WHERE id = :i"), {"i": res["items"][0]["id"]})
        await db.rollback()

    wm = await tenant.ok(
        "PUT",
        "/v1/working-memory",
        json={
            "workspace_id": tenant.workspace_id,
            "session_id": sid,
            "key": "plan",
            "content": "step 1",
            "ttl_seconds": 60,
        },
    )
    wm2 = await tenant.ok(
        "PUT",
        "/v1/working-memory",
        json={
            "workspace_id": tenant.workspace_id,
            "session_id": sid,
            "key": "plan",
            "content": "step 2",
            "ttl_seconds": 60,
        },
    )
    assert wm["id"] == wm2["id"] and wm2["content"] == "step 2"
    items = await tenant.ok("GET", f"/v1/working-memory?workspace_id={tenant.workspace_id}&session_id={sid}")
    assert [i["content"] for i in items] == ["step 2"]
    async with container.sessions() as db:
        await db.execute(
            text("UPDATE working_memories SET expires_at = now() - interval '1 second' WHERE id = :i"), {"i": wm["id"]}
        )
        await db.commit()
    assert await tenant.ok("GET", f"/v1/working-memory?workspace_id={tenant.workspace_id}&session_id={sid}") == []


async def test_health_endpoints(client) -> None:  # type: ignore[no-untyped-def]
    assert (await client.get("/health/live")).json() == {"status": "ok"}
    r = await client.get("/health/ready")
    body = r.json()
    assert r.status_code == 200 and body["checks"]["database"]["ok"] and body["checks"]["redis"]["ok"]
    assert body["checks"]["database"]["pgvector"]
    metrics = await client.get("/metrics")
    assert "mnemos_http_request_seconds" in metrics.text

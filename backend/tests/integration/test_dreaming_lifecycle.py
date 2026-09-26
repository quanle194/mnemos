"""Scenarios 7 (dream dedup preserving provenance), 8 (expired/superseded excluded), dream modes/idempotency."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.jobs.worker import Worker
from tests.integration.conftest import Tenant
from tests.integration.helpers import active_memory, context_ids, learn, project_id

pytestmark = pytest.mark.integration

REPEATED = "Always run database migrations with --lock-timeout=5s before deploying the payments service."


async def _dream(t: Tenant, worker: Worker, mode: str) -> dict:
    d = await t.ok("POST", "/v1/dreams", json={"workspace_id": t.workspace_id, "mode": mode})
    await worker.drain()
    return await t.ok("GET", f"/v1/dreams/{d['id']}")


async def test_dedup_dream_preserves_provenance(tenant: Tenant, worker: Worker) -> None:
    pid = await project_id(tenant, "payments")
    exp_ids = []
    for i in range(3):
        created = await tenant.ok(
            "POST",
            "/v1/experiences",
            json={
                "workspace_id": tenant.workspace_id,
                "project_id": pid,
                "outcome": "success",
                "task": f"Deploy payments service #{i}",
                "observation": "Migration locked the ledger table.",
                "action": "Ran migrations with --lock-timeout=5s.",
                "result": "Deploy succeeded.",
            },
        )
        exp_ids.append(created["experience"]["id"])
    await worker.drain()
    mems = []
    for i, eid in enumerate(exp_ids):
        # maintainer records the same lesson three times with separate evidence (simulates concurrent writers)
        mems.append(
            await active_memory(
                tenant,
                worker,
                REPEATED + ("" if i == 0 else " "),
                project=pid,
                mtype="lesson",
                evidence=[{"source_type": "experience", "source_id": eid}],
            )
        )
    before = await context_ids(tenant, "deploy payments service migrations", project_id=pid)
    dream = await _dream(tenant, worker, "deduplication")
    assert dream["status"] == "succeeded", dream
    stats = dream["result_json"]["stats"]
    assert stats["superseded"] >= 2 and stats["compression_ratio"] >= 1.5
    statuses = {m["id"]: (await tenant.ok("GET", f"/v1/memories/{m['id']}"))["status"] for m in mems}
    canonical = [mid for mid, s in statuses.items() if s == "active"]
    assert len(canonical) == 1 and sorted(statuses.values()).count("superseded") == 2
    ev = await tenant.ok("GET", f"/v1/memories/{canonical[0]}/evidence")
    assert {e["source_id"] for e in ev if e["source_type"] == "experience"} == set(exp_ids)  # provenance kept
    for mid, s in statuses.items():
        if s == "superseded":
            assert await tenant.ok("GET", f"/v1/memories/{mid}/evidence")  # originals keep their evidence
            rels = await tenant.ok("GET", f"/v1/memories/{mid}/relations")
            assert any(r["relation"] == "supersedes" and r["other"]["id"] == canonical[0] for r in rels)
    after = await context_ids(tenant, "deploy payments service migrations", project_id=pid)
    assert len([i for i in after if i in statuses]) == 1 and len(before) >= len(after)
    # re-running is a no-op
    again = await _dream(tenant, worker, "deduplication")
    assert again["result_json"]["stats"]["superseded"] == 0


async def test_reflection_pattern_compression_generalization(tenant: Tenant, worker: Worker) -> None:
    p1, p2 = await project_id(tenant, "svc-a"), await project_id(tenant, "svc-b")
    for pid in (p1, p2):
        for i in range(2):
            await tenant.ok(
                "POST",
                "/v1/experiences",
                json={
                    "workspace_id": tenant.workspace_id,
                    "project_id": pid,
                    "outcome": "failure",
                    "task": "Build docker image for service",
                    "action": "docker build without cache mount",
                    "observation": f"pip install timed out downloading wheels (run {i})",
                    "result": "Build failed after 20 minutes.",
                },
            )
        await tenant.ok(
            "POST",
            "/v1/experiences",
            json={
                "workspace_id": tenant.workspace_id,
                "project_id": pid,
                "outcome": "success",
                "task": "Build docker image for service",
                "action": "enabled BuildKit pip cache mount",
                "observation": "pip install timed out previously",
                "result": "Build succeeded in 2 minutes.",
            },
        )
    await worker.drain()
    reflection = await _dream(tenant, worker, "reflection")
    assert reflection["status"] == "succeeded" and reflection["result_json"]["proposals"], reflection
    prop = await tenant.ok("GET", f"/v1/memories/{reflection['result_json']['proposals'][0]}")
    assert prop["metadata_json"]["dream"]["mode"] == "reflection"
    ev = await tenant.ok("GET", f"/v1/memories/{prop['id']}/evidence")
    assert len([e for e in ev if e["source_type"] == "experience"]) >= 2
    # re-running reflection on the same window: checkpoint means nothing new is processed
    again = await _dream(tenant, worker, "reflection")
    assert again["result_json"]["stats"]["experiences"] == 0

    pattern = await _dream(tenant, worker, "pattern")
    assert pattern["status"] == "succeeded"
    assert pattern["result_json"]["stats"]["clusters"] >= 1 and pattern["result_json"]["proposals"]

    # compression: two related-but-distinct active lessons in one project are consolidated
    a = await active_memory(
        tenant,
        worker,
        "When building the docker image enable the BuildKit pip cache mount. It avoids pip timeouts.",
        project=p1,
    )
    b = await active_memory(
        tenant,
        worker,
        "When building the docker image enable the BuildKit pip cache mount. Also pin the base image digest.",
        project=p1,
    )
    comp = await _dream(tenant, worker, "compression")
    assert comp["status"] == "succeeded", comp
    applied = [x for x in comp["result_json"]["applied"] if a["id"] in x["members"]]
    assert applied and b["id"] in applied[0]["members"]
    consolidated = await tenant.ok("GET", f"/v1/memories/{applied[0]['consolidated']}")
    assert consolidated["status"] == "active"
    assert "pip timeouts" in consolidated["content"] and "base image digest" in consolidated["content"]
    for mid in (a["id"], b["id"]):
        assert (await tenant.ok("GET", f"/v1/memories/{mid}"))["status"] == "superseded"

    # generalization across projects -> reviewable workspace-scoped candidate
    await active_memory(tenant, worker, "Enable the BuildKit pip cache mount for docker builds of svc-b.", project=p2)
    await active_memory(tenant, worker, "Enable the BuildKit pip cache mount for docker builds of svc-a.", project=p1)
    gen = await _dream(tenant, worker, "generalization")
    assert gen["status"] == "succeeded"
    assert gen["result_json"]["proposals"], gen["result_json"]
    g = await tenant.ok("GET", f"/v1/memories/{gen['result_json']['proposals'][0]}")
    assert g["status"] == "candidate" and g["review_state"] == "pending" and g["scope_type"] == "workspace"
    rels = await tenant.ok("GET", f"/v1/memories/{g['id']}/relations")
    assert sum(1 for r in rels if r["relation"] == "generalizes") >= 2
    approved = await tenant.ok("POST", f"/v1/memories/{g['id']}/review", json={"approve": True, "note": "ok"})
    assert approved["status"] == "active"


async def test_contradiction_dream_and_auto_resolution(tenant: Tenant, worker: Worker) -> None:
    pid = await project_id(tenant, "cfg")
    old = await active_memory(
        tenant, worker, "The api service listens on port 8080 in staging.", project=pid, mtype="fact"
    )
    new = await active_memory(
        tenant,
        worker,
        "The api service no longer listens on port 8080 in staging; it now uses port 9090.",
        project=pid,
        mtype="fact",
    )
    # both were created active by a maintainer (privileged path) -> the contradiction dream must find them
    d = await _dream(tenant, worker, "contradiction")
    assert d["status"] == "succeeded", d
    stats = d["result_json"]["stats"]
    assert stats["conflicts_opened"] == 1
    # supersede hint + equal trust -> policy auto-resolves in favour of the newer memory
    assert stats["auto_resolved"] == 1
    assert (await tenant.ok("GET", f"/v1/memories/{old['id']}"))["status"] == "superseded"
    assert (await tenant.ok("GET", f"/v1/memories/{new['id']}"))["status"] == "active"
    audit = await tenant.ok("GET", f"/v1/audit-logs?action=conflict.resolve&workspace_id={tenant.workspace_id}")
    assert audit["items"] and audit["items"][0]["after_json"]["auto"] is True


async def test_expired_and_superseded_absent_from_context(tenant: Tenant, worker: Worker) -> None:
    pid = await project_id(tenant, "exp")
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    future = (datetime.now(UTC) + timedelta(days=30)).isoformat()
    expired = await active_memory(
        tenant,
        worker,
        "Holiday freeze: no deploys to the orders service this week.",
        project=pid,
        mtype="constraint",
        valid_until=past,
    )
    valid = await active_memory(
        tenant,
        worker,
        "Orders service deploys require a canary stage.",
        project=pid,
        mtype="procedure",
        valid_until=future,
    )
    ids = await context_ids(tenant, "deploys to the orders service", project_id=pid)
    assert valid["id"] in ids and expired["id"] not in ids
    # candidates only appear when explicitly requested
    cand = await tenant.ok(
        "POST",
        "/v1/memories",
        json={
            "workspace_id": tenant.workspace_id,
            "project_id": pid,
            "type": "fact",
            "scope_type": "project",
            "title": "orders deploy owner",
            "content": "Orders service deploys are owned by team kestrel.",
        },
    )
    ids_default = await context_ids(tenant, "orders service deploys owner", project_id=pid)
    ids_cand = await context_ids(tenant, "orders service deploys owner", project_id=pid, include_candidates=True)
    assert cand["id"] not in ids_default and cand["id"] in ids_cand
    # lifecycle sweep archives expired memories (history kept)
    await worker.schedule_once()
    await worker.drain()
    got = await tenant.ok("GET", f"/v1/memories/{expired['id']}")
    assert got["status"] == "archived" and got["metadata_json"]["archived_reason"] == "expired"
    # superseded via conflict resolution is excluded (covered in conflict test) and via PATCH lifecycle:
    m = await active_memory(tenant, worker, "Orders service uses feature flag service v1.", project=pid)
    r = await tenant.ok(
        "PATCH",
        f"/v1/memories/{m['id']}",
        json={"status": "superseded", "reason": "v2 rollout"},
        headers={"If-Match": f'"{m["version"]}"'},
    )
    assert r["status"] == "superseded"
    assert m["id"] not in await context_ids(tenant, "orders feature flag service", project_id=pid)


async def test_scheduled_dreams_are_idempotent_per_window(tenant: Tenant, worker: Worker, container) -> None:  # type: ignore[no-untyped-def]
    from app.db.models import DreamJob, Workspace
    from app.modules import dreaming_service
    from app.modules.ctx import Ctx
    from app.tenancy import Principal

    for i in range(2):
        await learn(
            tenant,
            worker,
            task=f"Scheduled window task {i}",
            observation="obs text long enough here",
            action="did a thing",
            result="it worked fine",
        )
    async with container.sessions() as db:
        import uuid

        ctx = Ctx(db=db, principal=Principal.system(uuid.UUID(tenant.org_id)), container=container)
        ws = await db.get(Workspace, uuid.UUID(tenant.workspace_id))
        j1, c1 = await dreaming_service.request_dream(ctx, ws.id, dreaming_service.DreamMode.REFLECTION, "schedule")
        await ctx.commit()
        j2, c2 = await dreaming_service.request_dream(ctx, ws.id, dreaming_service.DreamMode.REFLECTION, "schedule")
        await ctx.commit()
        assert c1 and not c2 and j1.id == j2.id
        created = await dreaming_service.schedule_workspace(ctx, ws)
        await ctx.commit()
        assert len(created) >= 5  # interval trigger with new experiences -> one job per remaining mode
        again = await dreaming_service.schedule_workspace(ctx, ws)
        assert again == []
        from sqlalchemy import func, select

        n = await db.scalar(select(func.count()).select_from(DreamJob).where(DreamJob.workspace_id == ws.id))
        assert n == 1 + len(created)
    await worker.drain()
    dreams = (await tenant.ok("GET", f"/v1/dreams?workspace_id={tenant.workspace_id}"))["items"]
    assert all(d["status"] == "succeeded" for d in dreams), [(d["mode"], d["error"]) for d in dreams]

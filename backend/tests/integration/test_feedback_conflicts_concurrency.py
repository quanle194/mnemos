"""Scenarios 4 (feedback), 5 (contradiction -> dispute/supersede), 6 (concurrent PATCH), idempotency."""

from __future__ import annotations

import asyncio

import pytest

from app.jobs.worker import Worker
from tests.integration.conftest import Tenant
from tests.integration.helpers import active_memory, context_ids, learn, project_id

pytestmark = pytest.mark.integration


async def test_feedback_updates_utility_and_lifecycle(tenant: Tenant, worker: Worker) -> None:
    m = await active_memory(tenant, worker, "The staging cluster uses Postgres 16 with pgvector 0.8.")
    before = m["utility_score"]
    res = await tenant.ok("POST", f"/v1/memories/{m['id']}/feedback", json={"value": "helpful", "note": "worked"})
    assert res["memory"]["utility_score"] > before
    after = await tenant.ok("GET", f"/v1/memories/{m['id']}")
    assert after["utility_score"] == res["memory"]["utility_score"]
    assert after["content"] == m["content"] and after["version"] == m["version"]  # feedback never rewrites memory
    fb = await tenant.ok("GET", f"/v1/memories/{m['id']}/feedback")
    assert fb[0]["value"] == "helpful"

    # incorrect feedback twice -> disputed and removed from normal context
    wrong = await active_memory(tenant, worker, "The staging cluster runs Redis 5 in cluster mode.")
    assert wrong["id"] in await context_ids(tenant, "staging cluster Redis version")
    await tenant.ok("POST", f"/v1/memories/{wrong['id']}/feedback", json={"value": "incorrect"})
    r = await tenant.ok("POST", f"/v1/memories/{wrong['id']}/feedback", json={"value": "incorrect"})
    assert r["memory"]["status"] == "disputed" and r["memory"]["lifecycle_action"] == "disputed"
    assert wrong["id"] not in await context_ids(tenant, "staging cluster Redis version")

    # harmful -> immediate quarantine
    bad = await active_memory(tenant, worker, "Clear the build cache by deleting the /var/lib directory.")
    r = await tenant.ok("POST", f"/v1/memories/{bad['id']}/feedback", json={"value": "harmful"})
    assert r["memory"]["status"] == "disputed"

    # outdated twice -> valid_until set -> excluded; lifecycle sweep archives it
    old = await active_memory(tenant, worker, "Release notes are published on the legacy wiki page.")
    for _ in range(2):
        await tenant.ok("POST", f"/v1/memories/{old['id']}/feedback", json={"value": "outdated"})
    got = await tenant.ok("GET", f"/v1/memories/{old['id']}")
    assert got["valid_until"] is not None
    assert old["id"] not in await context_ids(tenant, "where are release notes published")
    history = await tenant.ok("GET", f"/v1/memories/{old['id']}/history")
    assert any("outdated" in h["change_reason"] for h in history)


async def test_contradiction_creates_conflict_not_overwrite(tenant: Tenant, worker: Worker) -> None:
    pid = await project_id(tenant, "web")
    _, first = await learn(
        tenant,
        worker,
        project_id=pid,
        agent_name="a",
        task="Install dashboard dependencies",
        metadata={
            "lessons": [
                "Use pnpm instead of npm to install the web dashboard "
                "dependencies because the lockfile is pnpm-lock.yaml."
            ]
        },
    )
    existing = first[0]
    assert existing["status"] == "active"
    _, second = await learn(
        tenant,
        worker,
        project_id=pid,
        agent_name="b",
        task="Install dashboard dependencies",
        metadata={
            "lessons": [
                "Use npm instead of pnpm to install the web dashboard "
                "dependencies because the lockfile is package-lock.json now."
            ]
        },
    )
    cand = second[0]
    assert cand["status"] == "disputed", cand
    assert (await tenant.ok("GET", f"/v1/memories/{existing['id']}"))["status"] == "active"  # no silent overwrite
    conflicts = (await tenant.ok("GET", f"/v1/conflicts?workspace_id={tenant.workspace_id}&status=open"))["items"]
    conflict = next(c for c in conflicts if c["candidate_memory_id"] == cand["id"])
    assert conflict["existing_memory_id"] == existing["id"]
    assert conflict["conflict_type"] == "preference_swap"
    rels = await tenant.ok("GET", f"/v1/memories/{cand['id']}/relations")
    assert any(r["relation"] == "contradicts" and r["other"]["id"] == existing["id"] for r in rels)
    ids = await context_ids(tenant, "install web dashboard dependencies pnpm npm", project_id=pid)
    assert existing["id"] in ids and cand["id"] not in ids  # disputed knowledge is not served

    # maintainer accepts the newer knowledge -> superseding path, history preserved
    detail = await tenant.ok(
        "POST",
        f"/v1/conflicts/{conflict['id']}/resolve",
        json={"resolution": "accept_candidate", "note": "lockfile migrated"},
    )
    assert detail["status"] == "resolved"
    assert detail["candidate"]["status"] == "active" and detail["existing"]["status"] == "superseded"
    rels = await tenant.ok("GET", f"/v1/memories/{existing['id']}/relations")
    assert any(r["relation"] == "supersedes" and r["other"]["id"] == cand["id"] for r in rels)
    ids = await context_ids(tenant, "install web dashboard dependencies pnpm npm", project_id=pid)
    assert cand["id"] in ids and existing["id"] not in ids
    hist = await tenant.ok("GET", f"/v1/memories/{existing['id']}/history")
    assert hist[0]["snapshot_json"]["content"] == existing["content"]  # original preserved
    r = await tenant.req("POST", f"/v1/conflicts/{conflict['id']}/resolve", json={"resolution": "keep_both"})
    assert r.status_code == 409


async def test_concurrent_patch_exactly_one_wins(tenant: Tenant, worker: Worker) -> None:
    m = await active_memory(tenant, worker, "Nightly batch job runs at 02:00 UTC.")
    assert m["version"] == 3  # candidate -> validated -> active

    async def patch(content: str):  # type: ignore[no-untyped-def]
        return await tenant.req(
            "PATCH", f"/v1/memories/{m['id']}", json={"content": content}, headers={"If-Match": f'"{m["version"]}"'}
        )

    results = await asyncio.gather(
        patch("Nightly batch job runs at 03:00 UTC."), patch("Nightly batch job runs at 04:00 UTC.")
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409], [r.text for r in results]
    loser = next(r for r in results if r.status_code == 409).json()
    assert loser["error"]["details"]["current_version"] == m["version"] + 1
    winner = next(r for r in results if r.status_code == 200)
    assert winner.headers["ETag"] == f'"{m["version"] + 1}"'
    hist = await tenant.ok("GET", f"/v1/memories/{m['id']}/history")
    assert len(hist) == m["version"] + 1
    # PATCH without a version precondition is refused
    r = await tenant.req("PATCH", f"/v1/memories/{m['id']}", json={"content": "x"})
    assert r.status_code == 428
    # invalid transition is a conflict, not a silent change
    r = await tenant.req(
        "PATCH", f"/v1/memories/{m['id']}", json={"status": "candidate"}, headers={"If-Match": winner.headers["ETag"]}
    )
    assert r.status_code == 409


async def test_idempotency_key_replays_and_rejects_reuse(tenant: Tenant, worker: Worker) -> None:
    body = {
        "workspace_id": tenant.workspace_id,
        "task": "Idempotent task",
        "outcome": "failure",
        "observation": "Something went wrong with the idempotent task runner today.",
    }
    h = {"Idempotency-Key": "exp-123"}
    r1 = await tenant.req("POST", "/v1/experiences", json=body, headers=h)
    r2 = await tenant.req("POST", "/v1/experiences", json=body, headers=h)
    assert r1.status_code == r2.status_code == 201
    assert r1.json()["experience"]["id"] == r2.json()["experience"]["id"]
    assert r2.headers.get("Idempotent-Replayed") == "true"
    listed = await tenant.ok("GET", f"/v1/experiences?workspace_id={tenant.workspace_id}")
    assert sum(1 for e in listed["items"] if e["task"] == "Idempotent task") == 1
    r3 = await tenant.req("POST", "/v1/experiences", json={**body, "task": "different"}, headers=h)
    assert r3.status_code == 409 and r3.json()["error"]["code"] == "idempotency_key_reused"
    # concurrent requests with the same key create exactly one experience
    h2 = {"Idempotency-Key": "exp-concurrent"}
    rs = await asyncio.gather(
        *[tenant.req("POST", "/v1/experiences", json={**body, "task": "Concurrent"}, headers=h2) for _ in range(5)]
    )
    assert {r.status_code for r in rs} == {201}
    assert len({r.json()["experience"]["id"] for r in rs}) == 1

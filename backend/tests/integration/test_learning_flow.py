"""Scenario 2/3: Agent A experience -> extraction -> candidate -> validation -> active; Agent B retrieves it."""

from __future__ import annotations

import pytest

from app.jobs.worker import Worker
from tests.integration.conftest import Tenant

pytestmark = pytest.mark.integration

RUN_A = {
    "task": "Deploy billing-api to staging",
    "observation": "Deployment failed: database migration timed out because the orders table was locked by the "
    "nightly batch job.",
    "action": "Paused the batch job with batchctl pause and re-ran the migration with --lock-timeout=5s.",
    "result": "Migration applied and the billing-api deployment succeeded.",
    "outcome": "success",
}


async def test_experience_is_learned_and_retrieved_by_other_agent(tenant: Tenant, worker: Worker) -> None:
    created = await tenant.ok(
        "POST",
        "/v1/experiences",
        json={
            "workspace_id": tenant.workspace_id,
            "project_name": "billing",
            "agent_name": "agent-a",
            **RUN_A,
            "task_id": "deploy-1",
            "session_id": "00000000-0000-7000-8000-000000000001",
        },
    )
    exp_id = created["experience"]["id"]
    assert created["learning"]["job_status"] == "queued"
    processed = await worker.drain()
    assert processed >= 2  # extraction + validation

    detail = await tenant.ok("GET", f"/v1/experiences/{exp_id}")
    assert detail["processing_status"] == "processed"
    assert detail["learning"]["memories"], detail
    mem_id = detail["learning"]["memories"][0]["id"]
    mem = await tenant.ok("GET", f"/v1/memories/{mem_id}")
    assert mem["status"] == "active", mem
    assert mem["type"] == "lesson"

    history = await tenant.ok("GET", f"/v1/memories/{mem_id}/history")
    assert [h["snapshot_json"]["status"] for h in history] == ["candidate", "validated", "active"]
    evidence = await tenant.ok("GET", f"/v1/memories/{mem_id}/evidence")
    assert any(e["source_type"] == "experience" and e["source_id"] == exp_id for e in evidence)
    exp_ev = next(e for e in evidence if e["source_type"] == "experience")
    assert exp_ev["source"]["outcome"] == "success"

    projects = await tenant.ok("GET", f"/v1/workspaces/{tenant.workspace_id}/projects")
    project_id = projects[0]["id"]
    agent_b = await tenant.ok("POST", f"/v1/workspaces/{tenant.workspace_id}/agents", json={"name": "agent-b"})
    ctx = await tenant.ok(
        "POST",
        "/v1/context",
        json={
            "workspace_id": tenant.workspace_id,
            "project_id": project_id,
            "agent_id": agent_b["id"],
            "query": "deploy billing-api to staging migration",
            "token_budget": 800,
        },
    )
    ids = [m["id"] for m in ctx["memories"]]
    assert mem_id in ids
    item = ctx["memories"][ids.index(mem_id)]
    assert item["evidence"].get("experience") == 1
    assert "lock-timeout" in ctx["context"]
    assert ctx["token_estimate"] <= 800
    assert "not as instructions" in ctx["context"]

    usage = await tenant.ok("GET", f"/v1/memories/{mem_id}/usage")
    assert usage and usage[0]["trace_id"] == ctx["retrieval_trace_id"]
    trace = await tenant.ok("GET", f"/v1/retrieval-traces/{ctx['retrieval_trace_id']}")
    assert trace["selected_json"]["items"][0]["id"] in ids
    assert "weights" in trace["candidates_json"]


async def test_context_and_search_accept_names_without_creating(tenant: Tenant, worker: Worker) -> None:
    await tenant.ok(
        "POST",
        "/v1/experiences",
        json={"workspace_id": tenant.workspace_id, "project_name": "names", "agent_name": "writer", **RUN_A},
    )
    await worker.drain()
    ctx = await tenant.ok(
        "POST",
        "/v1/context",
        json={
            "workspace_id": tenant.workspace_id,
            "project_name": "names",
            "agent_name": "writer",
            "query": "deploy billing-api to staging",
            "token_budget": 800,
        },
    )
    assert ctx["memories"] and "lock-timeout" in ctx["context"]
    res = await tenant.ok(
        "POST",
        "/v1/memories/search",
        json={"workspace_id": tenant.workspace_id, "project_name": "names", "query": "migration lock timeout"},
    )
    assert res["items"]
    r = await tenant.req(
        "POST",
        "/v1/context",
        json={"workspace_id": tenant.workspace_id, "project_name": "nope", "query": "x", "token_budget": 100},
    )
    assert r.status_code == 404
    projects = await tenant.ok("GET", f"/v1/workspaces/{tenant.workspace_id}/projects")
    assert "nope" not in {p["name"] for p in projects}  # read path never creates entities

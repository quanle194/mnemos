"""Scenario 1: two tenants are completely isolated (direct ID, search, vector search, relations, evidence,
traces, dream jobs, conflicts, experiences, episodes) + RBAC baseline."""

from __future__ import annotations

import pytest

from app.jobs.worker import Worker
from tests.integration.conftest import Tenant
from tests.integration.helpers import active_memory, learn, project_id, uid

pytestmark = pytest.mark.integration

SECRET_EXP = {
    "task": "Rotate the zebra-cluster TLS certificates",
    "observation": "Rotation failed because the old intermediate CA was still pinned in the ingress config.",
    "action": "Removed the pinned intermediate CA from ingress and re-issued certificates with certbot.",
    "result": "Certificates rotated; zebra-cluster healthy.",
}


async def test_cross_tenant_access_is_impossible(tenant: Tenant, tenant_b: Tenant, worker: Worker) -> None:
    a, b = tenant, tenant_b
    pid = await project_id(a, "zebra")
    exp_id, mems = await learn(a, worker, project_id=pid, agent_name="a1", session_id=uid(), task_id="t1", **SECRET_EXP)
    mem = mems[0]
    assert mem["status"] == "active"
    other = await active_memory(
        a, worker, "Zebra-cluster ingress must not pin intermediate CAs.", project=pid, mtype="fact"
    )
    ctx_a = await a.ok(
        "POST",
        "/v1/context",
        json={
            "workspace_id": a.workspace_id,
            "project_id": pid,
            "query": "zebra-cluster TLS certificates",
            "token_budget": 2000,
        },
    )
    trace_id = ctx_a["retrieval_trace_id"]
    dream = await a.ok("POST", "/v1/dreams", json={"workspace_id": a.workspace_id, "mode": "deduplication"})
    await worker.drain()
    episode_id = (await a.ok("GET", f"/v1/experiences/{exp_id}"))["episode_id"]
    assert episode_id

    # direct ID access -> 404 for every resource type
    for path in (
        f"/v1/memories/{mem['id']}",
        f"/v1/memories/{mem['id']}/evidence",
        f"/v1/memories/{mem['id']}/history",
        f"/v1/memories/{mem['id']}/relations",
        f"/v1/memories/{mem['id']}/usage",
        f"/v1/memories/{mem['id']}/feedback",
        f"/v1/experiences/{exp_id}",
        f"/v1/episodes/{episode_id}",
        f"/v1/retrieval-traces/{trace_id}",
        f"/v1/dreams/{dream['id']}",
        f"/v1/workspaces/{a.workspace_id}",
        f"/v1/workspaces/{a.workspace_id}/projects",
    ):
        r = await b.req("GET", path)
        assert r.status_code == 404, (path, r.status_code, r.text)

    # using the other tenant's workspace id in queries/writes -> 404
    for method, path, body in (
        ("POST", "/v1/context", {"workspace_id": a.workspace_id, "query": "zebra", "token_budget": 500}),
        ("POST", "/v1/memories/search", {"workspace_id": a.workspace_id, "query": "zebra"}),
        ("POST", "/v1/experiences", {"workspace_id": a.workspace_id, "task": "x", "outcome": "success"}),
        ("POST", "/v1/dreams", {"workspace_id": a.workspace_id, "mode": "reflection"}),
        (
            "POST",
            "/v1/memories",
            {"workspace_id": a.workspace_id, "type": "fact", "title": "t", "content": "c", "scope_type": "workspace"},
        ),
    ):
        r = await b.req(method, path, json=body)
        assert r.status_code == 404, (path, r.status_code, r.text)
    for path in (
        f"/v1/experiences?workspace_id={a.workspace_id}",
        f"/v1/episodes?workspace_id={a.workspace_id}",
        f"/v1/dreams?workspace_id={a.workspace_id}",
        f"/v1/stats?workspace_id={a.workspace_id}",
        f"/v1/graph?workspace_id={a.workspace_id}",
        f"/v1/retrieval-traces?workspace_id={a.workspace_id}",
        f"/v1/memories?workspace_id={a.workspace_id}",
    ):
        r = await b.req("GET", path)
        assert r.status_code == 404, (path, r.status_code)

    # mutations on foreign ids -> 404
    assert (await b.req("POST", f"/v1/memories/{mem['id']}/feedback", json={"value": "harmful"})).status_code == 404
    assert (
        await b.req("PATCH", f"/v1/memories/{mem['id']}", json={"title": "x"}, headers={"If-Match": '"1"'})
    ).status_code == 404
    assert (await b.req("DELETE", f"/v1/memories/{mem['id']}")).status_code == 404

    # search/vector search in B's own workspace with identical query never returns A's data
    res = await b.ok(
        "POST",
        "/v1/memories/search",
        json={"workspace_id": b.workspace_id, "query": "zebra-cluster TLS certificates ingress"},
    )
    assert res["items"] == []
    ctx_b = await b.ok(
        "POST",
        "/v1/context",
        json={"workspace_id": b.workspace_id, "query": SECRET_EXP["task"], "token_budget": 2000, "min_relevance": 0},
    )
    assert ctx_b["memories"] == [] and "zebra" not in ctx_b["context"]
    listed = await b.ok("GET", "/v1/memories")
    assert all(m["organization_id"] == b.org_id for m in listed["items"])
    assert (await b.ok("GET", "/v1/conflicts"))["items"] == []
    jobs_b = (await b.ok("GET", "/v1/jobs"))["items"]
    assert not any(j["payload_json"].get("experience_id") == exp_id for j in jobs_b)
    audit_b = (await b.ok("GET", "/v1/audit-logs?limit=200"))["items"]
    assert not any(x["resource_id"] in (mem["id"], exp_id) for x in audit_b)

    # evidence must not reference another tenant's sources (no cross-tenant provenance)
    r = await b.req(
        "POST",
        "/v1/memories",
        json={
            "workspace_id": b.workspace_id,
            "type": "fact",
            "title": "steal",
            "content": "steal provenance",
            "scope_type": "workspace",
            "evidence": [{"source_type": "experience", "source_id": exp_id}],
        },
    )
    assert r.status_code == 404
    b_mem = await active_memory(b, worker, "B-only fact about tigers.")
    r = await a.req(
        "POST", f"/v1/memories/{other['id']}/relations", json={"target_memory_id": b_mem["id"], "relation": "supports"}
    )
    assert r.status_code == 404

    # A still sees its data
    assert (await a.ok("GET", f"/v1/memories/{mem['id']}"))["id"] == mem["id"]


async def test_workspace_restricted_key(tenant: Tenant, worker: Worker) -> None:
    ws2 = await tenant.ok("POST", "/v1/workspaces", json={"name": f"second-{uid()[:6]}"})
    restricted = await tenant.make_key("agent", [ws2["id"]])
    m = await active_memory(tenant, worker, "Main workspace secret fact about otters.")
    assert (await tenant.req("GET", f"/v1/memories/{m['id']}", key=restricted)).status_code == 404
    r = await tenant.req(
        "POST",
        "/v1/context",
        key=restricted,
        json={"workspace_id": tenant.workspace_id, "query": "otters", "token_budget": 500},
    )
    assert r.status_code == 404
    listed = await tenant.req("GET", "/v1/workspaces", key=restricted)
    assert [w["id"] for w in listed.json()] == [ws2["id"]]
    ok = await tenant.req(
        "POST", "/v1/context", key=restricted, json={"workspace_id": ws2["id"], "query": "otters", "token_budget": 500}
    )
    assert ok.status_code == 200 and ok.json()["memories"] == []


async def test_rbac_baseline(tenant: Tenant, worker: Worker) -> None:
    viewer = await tenant.make_key("viewer")
    agent = await tenant.make_key("agent")
    ws = tenant.workspace_id
    exp = {"workspace_id": ws, "task": "t", "outcome": "success"}
    assert (await tenant.req("POST", "/v1/experiences", key=viewer, json=exp)).status_code == 403
    assert (
        await tenant.req(
            "POST", "/v1/context", key=viewer, json={"workspace_id": ws, "query": "q", "token_budget": 100}
        )
    ).status_code == 200
    assert (await tenant.req("POST", "/v1/experiences", key=agent, json=exp)).status_code == 201
    # agents cannot create active/trusted or organizational memories, run dreams, manage keys
    for body in ({"status": "active"}, {"scope_type": "organization"}, {"layer": 4, "scope_type": "workspace"}):
        r = await tenant.req(
            "POST",
            "/v1/memories",
            key=agent,
            json={
                "workspace_id": ws,
                "type": "rule",
                "title": "t",
                "content": "Always deploy on Fridays.",
                "scope_type": "workspace",
                **body,
            },
        )
        assert r.status_code == 403, (body, r.text)
    assert (
        await tenant.req("POST", "/v1/dreams", key=agent, json={"workspace_id": ws, "mode": "reflection"})
    ).status_code == 403
    assert (await tenant.req("POST", "/v1/api-keys", key=agent, json={"name": "x", "role": "admin"})).status_code == 403
    m = await active_memory(tenant, worker, "Maintainers review promotions.")
    r = await tenant.req(
        "PATCH",
        f"/v1/memories/{m['id']}",
        key=agent,
        json={"status": "archived"},
        headers={"If-Match": f'"{m["version"]}"'},
    )
    assert r.status_code == 403
    # auth failures
    assert (await tenant.client.get("/v1/me")).status_code == 401
    assert (await tenant.client.get("/v1/me", headers={"Authorization": "Bearer mnm_bad_key"})).status_code == 401
    keys = await tenant.ok("GET", "/v1/api-keys")
    victim = next(k for k in keys if k["role"] == "viewer")
    await tenant.ok("DELETE", f"/v1/api-keys/{victim['id']}")
    assert (await tenant.req("GET", "/v1/me", key=viewer)).status_code == 401
    me = await tenant.req("GET", "/v1/me", key=agent)
    assert "experience:write" in me.json()["permissions"] and "memory:review" not in me.json()["permissions"]

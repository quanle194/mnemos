from __future__ import annotations

import uuid
from typing import Any

from app.jobs.worker import Worker
from tests.integration.conftest import Tenant


async def project_id(t: Tenant, name: str = "billing") -> str:
    return (await t.ok("POST", f"/v1/workspaces/{t.workspace_id}/projects", json={"name": name}))["id"]


async def agent_id(t: Tenant, name: str) -> str:
    return (await t.ok("POST", f"/v1/workspaces/{t.workspace_id}/agents", json={"name": name}))["id"]


async def learn(t: Tenant, worker: Worker, **exp: Any) -> tuple[str, list[dict[str, Any]]]:
    """Record an experience, drain the queue, return (experience_id, derived memories)."""
    body = {"workspace_id": t.workspace_id, "outcome": "success", **exp}
    created = await t.ok("POST", "/v1/experiences", json=body)
    await worker.drain()
    exp_id = created["experience"]["id"]
    detail = await t.ok("GET", f"/v1/experiences/{exp_id}")
    mems = [await t.ok("GET", f"/v1/memories/{m['id']}") for m in detail["learning"]["memories"]]
    return exp_id, mems


async def active_memory(
    t: Tenant, worker: Worker, content: str, *, project: str | None = None, mtype: str = "lesson", **extra: Any
) -> dict[str, Any]:
    """Create an active memory through the maintainer path (privileged, audited)."""
    body: dict[str, Any] = {
        "workspace_id": t.workspace_id,
        "type": mtype,
        "title": content[:60],
        "content": content,
        "status": "active",
        "confidence": 0.8,
        "scope_type": "project" if project else "workspace",
        **extra,
    }
    if project:
        body["project_id"] = project
    m = await t.ok("POST", "/v1/memories", json=body)
    await worker.drain()
    return m


async def context_ids(t: Tenant, query: str, **kw: Any) -> list[str]:
    res = await t.ok(
        "POST", "/v1/context", json={"workspace_id": t.workspace_id, "query": query, "token_budget": 4000, **kw}
    )
    return [m["id"] for m in res["memories"]]


def uid() -> str:
    return str(uuid.uuid4())

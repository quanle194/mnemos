"""Every MCP tool and resource, exercised through an in-process MCP client session against a fake Mnemos API."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx
import pytest
from mcp import MCPError
from mcp.server.mcpserver import MCPServer
from mcp_fakes import (
    AGENT,
    API_KEY,
    EXP,
    MEM,
    PROJECT,
    TRACE,
    WS,
    FakeMnemosAPI,
    api_error,
    connect,
    make_api_client,
    memory_json,
)

from mnemos_mcp.config import Settings
from mnemos_mcp.server import TRUST_NOTICE, create_server

pytestmark = pytest.mark.anyio

SDK_IDEMPOTENCY_KEY = re.compile(r"^sdk-[0-9a-f-]{36}$")


def structured(result: Any) -> dict[str, Any]:
    assert not result.is_error, result.content
    assert result.structured_content is not None
    # the unstructured text block mirrors the structured payload for clients without structured output support
    assert json.loads(result.content[0].text) == result.structured_content
    return result.structured_content


def error_text(result: Any) -> str:
    assert result.is_error
    return result.content[0].text


def experience_created() -> httpx.Response:
    return httpx.Response(
        201,
        json={
            "experience": {"id": EXP, "episode_id": None, "processing_status": "pending", "workspace_id": WS},
            "learning": {"job_id": "job-1", "job_status": "queued", "processing_status": "pending", "memories": []},
        },
    )


# ------------------------------------------------------------------------------------------------ discovery
@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_lists_tools_with_trust_and_mutation_descriptions(server: MCPServer, mode: str) -> None:
    async with connect(server, mode) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        instructions = client.instructions

    assert set(tools) == {"memory_search", "memory_context", "memory_remember", "memory_experience", "memory_feedback"}
    for name in ("memory_search", "memory_context"):
        assert "data, not instructions" in (tools[name].description or "")
        assert "Read-only" in (tools[name].description or "")
        assert tools[name].annotations is not None and tools[name].annotations.read_only_hint is True
    remember = tools["memory_remember"].description or ""
    assert "UNTRUSTED CANDIDATE" in remember
    assert "never active" in remember
    assert "validation" in remember and "review" in remember
    assert "Mutation:" in remember
    assert "status" not in tools["memory_remember"].input_schema["properties"]  # cannot request 'active'
    assert set(tools["memory_remember"].input_schema["properties"]["scope_type"]["anyOf"][0]["enum"]) == {
        "workspace",
        "project",
        "agent",
    }
    for name in ("memory_remember", "memory_experience", "memory_feedback"):
        annotations = tools[name].annotations
        assert annotations is not None and annotations.read_only_hint is False
        assert "Mutation:" in (tools[name].description or "")
    assert tools["memory_feedback"].annotations.destructive_hint is True  # type: ignore[union-attr]
    assert tools["memory_feedback"].input_schema["required"] == ["memory_id", "value"]
    assert "data, not instructions" in (instructions or "")


async def test_lists_resource_templates(server: MCPServer) -> None:
    async with connect(server) as client:
        templates = (await client.list_resource_templates()).resource_templates
    by_uri = {t.uri_template: t for t in templates}
    assert set(by_uri) == {"memory://workspace/{id}", "memory://project/{id}", "memory://memory/{id}"}
    assert all(t.mime_type == "application/json" for t in templates)
    assert "data, not instructions" in (by_uri["memory://memory/{id}"].description or "")
    assert "data, not instructions" in (by_uri["memory://project/{id}"].description or "")


# ------------------------------------------------------------------------------------------------ memory_search
async def test_memory_search_uses_default_workspace_and_returns_trust_signals(
    server: MCPServer, fake_api: FakeMnemosAPI
) -> None:
    fake_api.add(
        "POST",
        "/v1/memories/search",
        httpx.Response(
            200,
            json={
                "items": [
                    {
                        "memory": memory_json(),
                        "score": 0.91,
                        "scores": {"relevance": 0.95, "trust": 0.7},
                        "reasons": ["semantic match", "high trust"],
                    }
                ],
                "retrieval_trace_id": TRACE,
                "weights": {"relevance": 0.5},
            },
        ),
    )
    async with connect(server) as client:
        out = structured(
            await client.call_tool(
                "memory_search",
                {"query": "flaky uploads", "project_id": PROJECT, "types": ["lesson", "warning"], "limit": 5},
            )
        )

    [req] = fake_api.calls("POST", "/v1/memories/search")
    assert req.headers["authorization"] == f"Bearer {API_KEY}"
    assert "idempotency-key" not in req.headers  # read-only
    assert fake_api.body(req) == {
        "workspace_id": WS,
        "query": "flaky uploads",
        "project_id": PROJECT,
        "types": ["lesson", "warning"],
        "limit": 5,
    }
    assert out["notice"] == TRUST_NOTICE
    assert out["retrieval_trace_id"] == TRACE
    [hit] = out["results"]
    assert hit["id"] == MEM
    assert hit["content"] == "S3 uploads need 3 retries with jitter."
    assert hit["trust_score"] == 0.7
    assert hit["status"] == "active"
    assert hit["score"] == 0.91
    assert hit["scores"] == {"relevance": 0.95, "trust": 0.7}
    assert hit["reasons"] == ["semantic match", "high trust"]
    assert "metadata_json" not in hit


async def test_memory_search_explicit_workspace_overrides_default(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    other = "77777777-7777-4777-8777-777777777777"
    fake_api.add(
        "POST",
        "/v1/memories/search",
        httpx.Response(200, json={"items": [], "retrieval_trace_id": TRACE, "weights": {}}),
    )
    async with connect(server, "legacy") as client:
        out = structured(await client.call_tool("memory_search", {"query": "x", "workspace_id": other}))
    assert fake_api.body(fake_api.requests[0])["workspace_id"] == other
    assert out["results"] == []


async def test_tools_require_a_workspace_when_no_default(fake_api: FakeMnemosAPI) -> None:
    server = create_server(Settings(workspace_id=None), make_api_client(fake_api))
    async with connect(server) as client:
        result = await client.call_tool("memory_search", {"query": "x"})
    assert "MNEMOS_WORKSPACE_ID" in error_text(result)
    assert fake_api.requests == []


async def test_api_errors_are_reported_as_tool_errors(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("POST", "/v1/memories/search", api_error(403, "forbidden", "API key not scoped to workspace"))
    async with connect(server) as client:
        result = await client.call_tool("memory_search", {"query": "x"})
    text = error_text(result)
    assert "403" in text and "forbidden" in text and "request_id=req-1" in text


async def test_unreachable_api_is_reported_without_crashing(fake_api: FakeMnemosAPI) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    fake_api.add("POST", "/v1/context", refuse)
    server = create_server(Settings(workspace_id=WS), make_api_client(fake_api))
    async with connect(server) as client:
        result = await client.call_tool("memory_context", {"query": "x"})
    assert "Mnemos API unreachable: ConnectError" in error_text(result)


# ------------------------------------------------------------------------------------------------ memory_context
async def test_memory_context_maps_arguments_and_returns_block(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add(
        "POST",
        "/v1/context",
        httpx.Response(
            200,
            json={
                "context": "## Relevant memories\n- [lesson] Retry flaky uploads",
                "memories": [
                    {
                        "id": MEM,
                        "type": "lesson",
                        "title": "Retry flaky uploads",
                        "content": "...",
                        "scope_type": "project",
                        "status": "active",
                        "confidence": 0.8,
                        "trust_score": 0.7,
                        "importance": 0.5,
                        "utility_score": 0.6,
                        "version": 2,
                        "score": 0.9,
                        "scores": {},
                        "reasons": ["semantic match"],
                        "tokens": 17,
                        "evidence": {"experience": 2},
                    }
                ],
                "token_estimate": 30,
                "token_budget": 1500,
                "token_estimate_method": "chars/4 heuristic",
                "retrieval_trace_id": TRACE,
                "candidate_count": 3,
                "excluded": [],
            },
        ),
    )
    async with connect(server) as client:
        out = structured(
            await client.call_tool(
                "memory_context",
                {
                    "query": "deploy billing",
                    "token_budget": 1500,
                    "project_id": PROJECT,
                    "agent_id": AGENT,
                    "memory_types": ["lesson"],
                    "max_items": 4,
                },
            )
        )

    [req] = fake_api.calls("POST", "/v1/context")
    assert fake_api.body(req) == {
        "workspace_id": WS,
        "query": "deploy billing",
        "token_budget": 1500,
        "project_id": PROJECT,
        "agent_id": AGENT,
        "memory_types": ["lesson"],
        "max_items": 4,
    }
    assert "include_candidates" not in fake_api.body(req)  # never widens retrieval to unvalidated candidates
    assert out["notice"] == TRUST_NOTICE
    assert out["context"].startswith("## Relevant memories")
    assert out["retrieval_trace_id"] == TRACE
    assert out["token_estimate"] == 30
    assert out["memories"] == [
        {
            "id": MEM,
            "type": "lesson",
            "title": "Retry flaky uploads",
            "status": "active",
            "scope_type": "project",
            "trust_score": 0.7,
            "confidence": 0.8,
            "score": 0.9,
            "reasons": ["semantic match"],
            "tokens": 17,
        }
    ]


async def test_memory_context_defaults(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add(
        "POST", "/v1/context", httpx.Response(200, json={"context": "", "memories": [], "retrieval_trace_id": TRACE})
    )
    async with connect(server) as client:
        structured(await client.call_tool("memory_context", {"query": "q"}))
    assert fake_api.body(fake_api.requests[0]) == {
        "workspace_id": WS,
        "query": "q",
        "token_budget": 2000,
        "max_items": 10,
    }


# ------------------------------------------------------------------------------------------------ memory_remember
async def test_memory_remember_only_proposes_a_candidate(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("POST", "/v1/memories", httpx.Response(201, json=memory_json(status="candidate", version=1)))
    async with connect(server) as client:
        out = structured(
            await client.call_tool(
                "memory_remember",
                {
                    "title": "Retry flaky uploads",
                    "content": "S3 uploads need 3 retries with jitter.",
                    "type": "lesson",
                    "project_id": PROJECT,
                    "confidence": 0.7,
                    "evidence_excerpt": "3 of 4 uploads failed first time",
                },
            )
        )

    [req] = fake_api.calls("POST", "/v1/memories")
    body = fake_api.body(req)
    assert body["status"] == "candidate"
    assert body["layer"] == 3
    assert body["scope_type"] == "project"
    assert body == {
        "workspace_id": WS,
        "type": "lesson",
        "title": "Retry flaky uploads",
        "content": "S3 uploads need 3 retries with jitter.",
        "project_id": PROJECT,
        "scope_type": "project",
        "confidence": 0.7,
        "importance": 0.5,
        "status": "candidate",
        "layer": 3,
        "metadata": {"proposed_via": "mcp:memory_remember"},
        "evidence": [
            {
                "source_type": "user_statement",
                "source_id": "mcp:memory_remember",
                "relation": "supports",
                "excerpt": "3 of 4 uploads failed first time",
            }
        ],
    }
    assert SDK_IDEMPOTENCY_KEY.match(req.headers["idempotency-key"])
    assert out["status"] == "candidate"
    assert out["memory_id"] == MEM
    assert "untrusted candidate" in out["message"]


async def test_memory_remember_cannot_be_escalated(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("POST", "/v1/memories", httpx.Response(201, json=memory_json(status="candidate")))
    async with connect(server) as client:
        # extra arguments such as status/layer are not part of the tool schema and never reach the API
        structured(
            await client.call_tool(
                "memory_remember",
                {"title": "t", "content": "c", "status": "active", "layer": 4, "idempotency_key": "remember-1"},
            )
        )
        org = await client.call_tool("memory_remember", {"title": "t", "content": "c", "scope_type": "organization"})
        agent_scope = await client.call_tool("memory_remember", {"title": "t", "content": "c", "scope_type": "agent"})

    [req] = fake_api.calls("POST", "/v1/memories")
    body = fake_api.body(req)
    assert body["status"] == "candidate"
    assert body["layer"] == 3
    assert body["scope_type"] == "workspace"  # no project/agent given
    assert body["type"] == "fact"
    assert req.headers["idempotency-key"] == "remember-1"
    assert "scope_type" in error_text(org)
    assert "requires agent_id" in error_text(agent_scope)


async def test_memory_remember_infers_agent_scope(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("POST", "/v1/memories", httpx.Response(201, json=memory_json(status="candidate", scope_type="agent")))
    async with connect(server) as client:
        structured(
            await client.call_tool(
                "memory_remember", {"title": "t", "content": "c", "agent_id": AGENT, "type": "preference"}
            )
        )
    body = fake_api.body(fake_api.requests[0])
    assert (body["scope_type"], body["agent_id"], body["type"]) == ("agent", AGENT, "preference")


# ------------------------------------------------------------------------------------------------ memory_experience
async def test_memory_experience_records_evidence(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("POST", "/v1/experiences", experience_created())
    async with connect(server) as client:
        out = structured(
            await client.call_tool(
                "memory_experience",
                {
                    "task": "deploy billing",
                    "outcome": "success",
                    "observation": "health check failed once",
                    "action": "fixed env var",
                    "result": "deployed",
                    "agent_name": "deployer",
                    "project_id": PROJECT,
                    "task_id": "run-7",
                    "importance": 0.8,
                },
            )
        )

    [req] = fake_api.calls("POST", "/v1/experiences")
    assert fake_api.body(req) == {
        "workspace_id": WS,
        "task": "deploy billing",
        "outcome": "success",
        "observation": "health check failed once",
        "action": "fixed env var",
        "result": "deployed",
        "project_id": PROJECT,
        "agent_name": "deployer",
        "task_id": "run-7",
        "importance": 0.8,
        "metadata": {"recorded_via": "mcp:memory_experience"},
    }
    assert "source" not in fake_api.body(req)  # callers cannot claim a more trusted source
    assert SDK_IDEMPOTENCY_KEY.match(req.headers["idempotency-key"])
    assert out["experience_id"] == EXP
    assert out["processing_status"] == "pending"
    assert out["learning"] == {"job_id": "job-1", "job_status": "queued"}


async def test_memory_experience_rejects_invalid_outcome(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    async with connect(server) as client:
        result = await client.call_tool("memory_experience", {"task": "t", "outcome": "great"})
    assert "outcome" in error_text(result)
    assert fake_api.requests == []


async def test_memory_experience_retries_with_a_stable_idempotency_key(fake_api: FakeMnemosAPI) -> None:
    fake_api.add("POST", "/v1/experiences", api_error(503, "unavailable", "restarting"), experience_created())
    server = create_server(Settings(workspace_id=WS), make_api_client(fake_api, max_retries=2))
    async with connect(server) as client:
        out = structured(
            await client.call_tool(
                "memory_experience", {"task": "t", "outcome": "failure", "idempotency_key": "exp-run-9"}
            )
        )
    first, second = fake_api.calls("POST", "/v1/experiences")
    assert first.headers["idempotency-key"] == second.headers["idempotency-key"] == "exp-run-9"
    assert first.content == second.content
    assert out["experience_id"] == EXP


# ------------------------------------------------------------------------------------------------ memory_feedback
async def test_memory_feedback(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add(
        "POST",
        f"/v1/memories/{MEM}/feedback",
        httpx.Response(
            201,
            json={
                "feedback": {
                    "id": "fb-1",
                    "memory_id": MEM,
                    "value": "incorrect",
                    "note": "wrong bucket",
                    "agent_id": None,
                    "task_id": "run-7",
                    "retrieval_trace_id": TRACE,
                    "created_at": "x",
                },
                "memory": {"id": MEM, "status": "active", "trust_score": 0.55, "utility_score": 0.4},
            },
        ),
    )
    async with connect(server) as client:
        out = structured(
            await client.call_tool(
                "memory_feedback",
                {
                    "memory_id": MEM,
                    "value": "incorrect",
                    "note": "wrong bucket",
                    "retrieval_trace_id": TRACE,
                    "task_id": "run-7",
                },
            )
        )

    [req] = fake_api.calls("POST", f"/v1/memories/{MEM}/feedback")
    assert fake_api.body(req) == {
        "value": "incorrect",
        "note": "wrong bucket",
        "retrieval_trace_id": TRACE,
        "task_id": "run-7",
    }
    assert SDK_IDEMPOTENCY_KEY.match(req.headers["idempotency-key"])
    assert out == {
        "feedback_id": "fb-1",
        "memory_id": MEM,
        "value": "incorrect",
        "memory": {"id": MEM, "status": "active", "trust_score": 0.55, "utility_score": 0.4},
    }


async def test_memory_feedback_validates_inputs(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    async with connect(server) as client:
        bad_id = await client.call_tool("memory_feedback", {"memory_id": "../admin", "value": "helpful"})
        bad_value = await client.call_tool("memory_feedback", {"memory_id": MEM, "value": "love it"})
    assert "memory_id" in error_text(bad_id)
    assert "value" in error_text(bad_value)
    assert fake_api.requests == []


# ------------------------------------------------------------------------------------------------ resources
async def read_json(client: Any, uri: str) -> dict[str, Any]:
    result = await client.read_resource(uri)
    [content] = result.contents
    assert content.mime_type == "application/json"
    assert str(content.uri) == uri
    return json.loads(content.text)


async def test_workspace_resource(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add(
        "GET",
        f"/v1/workspaces/{WS}",
        httpx.Response(
            200, json={"id": WS, "organization_id": "o", "name": "default", "settings_json": {}, "created_at": "x"}
        ),
    )
    fake_api.add(
        "GET",
        "/v1/stats",
        httpx.Response(
            200, json={"workspace_id": WS, "memories_by_status": {"active": 3, "candidate": 2}, "pending_review": 1}
        ),
    )
    async with connect(server) as client:
        data = await read_json(client, f"memory://workspace/{WS}")

    [stats_req] = fake_api.calls("GET", "/v1/stats")
    assert stats_req.url.params["workspace_id"] == WS
    assert stats_req.headers["authorization"] == f"Bearer {API_KEY}"
    assert data["workspace"]["name"] == "default"
    assert data["stats"]["memories_by_status"] == {"active": 3, "candidate": 2}
    assert data["stats"]["pending_review"] == 1


async def test_project_resource_lists_active_memories(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("GET", "/v1/memories", httpx.Response(200, json={"items": [memory_json()], "next_cursor": None}))
    async with connect(server, "legacy") as client:
        data = await read_json(client, f"memory://project/{PROJECT}")

    [req] = fake_api.calls("GET", "/v1/memories")
    assert dict(req.url.params) == {"project_id": PROJECT, "status": "active", "limit": "100"}
    assert data["notice"] == TRUST_NOTICE
    assert data["project_id"] == PROJECT
    assert [m["id"] for m in data["memories"]] == [MEM]
    assert data["memories"][0]["trust_score"] == 0.7
    assert data["next_cursor"] is None


async def test_memory_resource_includes_evidence_and_history_summary(
    server: MCPServer, fake_api: FakeMnemosAPI
) -> None:
    fake_api.add("GET", f"/v1/memories/{MEM}", httpx.Response(200, json=memory_json()))
    fake_api.add(
        "GET",
        f"/v1/memories/{MEM}/evidence",
        httpx.Response(
            200,
            json=[
                {
                    "id": "e1",
                    "source_type": "experience",
                    "source_id": EXP,
                    "relation": "supports",
                    "weight": 1.0,
                    "excerpt": "uploads failed",
                    "created_at": "x",
                    "source": {"task": "t"},
                }
            ],
        ),
    )
    fake_api.add(
        "GET",
        f"/v1/memories/{MEM}/history",
        httpx.Response(
            200,
            json=[
                {
                    "id": "v1",
                    "version": 1,
                    "snapshot_json": {"content": "old"},
                    "change_reason": "created",
                    "actor_type": "agent",
                    "actor_id": "key:1",
                    "created_at": "x",
                },
                {
                    "id": "v2",
                    "version": 2,
                    "snapshot_json": {"content": "new"},
                    "change_reason": "promoted",
                    "actor_type": "system",
                    "actor_id": None,
                    "created_at": "y",
                },
            ],
        ),
    )
    async with connect(server) as client:
        data = await read_json(client, f"memory://memory/{MEM}")

    assert data["notice"] == TRUST_NOTICE
    assert data["memory"]["id"] == MEM
    assert data["memory"]["content"] == "S3 uploads need 3 retries with jitter."
    assert data["memory"]["metadata"] == {"source_system": "ci"}
    assert data["evidence"] == [
        {
            "source_type": "experience",
            "source_id": EXP,
            "relation": "supports",
            "weight": 1.0,
            "excerpt": "uploads failed",
            "created_at": "x",
        }
    ]
    assert data["history"] == [
        {"version": 1, "change_reason": "created", "actor_type": "agent", "actor_id": "key:1", "created_at": "x"},
        {"version": 2, "change_reason": "promoted", "actor_type": "system", "actor_id": None, "created_at": "y"},
    ]  # summary only: no full snapshots


async def test_resources_reject_non_uuid_ids_without_calling_the_api(
    server: MCPServer, fake_api: FakeMnemosAPI
) -> None:
    async with connect(server) as client:
        for uri in ("memory://memory/not-a-uuid", "memory://workspace/abc", "memory://project/1"):
            with pytest.raises(MCPError, match="must be a UUID"):
                await client.read_resource(uri)
    assert fake_api.requests == []


async def test_resource_not_found_and_api_errors(server: MCPServer, fake_api: FakeMnemosAPI) -> None:
    fake_api.add("GET", f"/v1/workspaces/{WS}", api_error(500, "internal_error", "boom"))
    async with connect(server) as client:
        with pytest.raises(MCPError, match="404"):
            await client.read_resource(f"memory://memory/{MEM}")  # no route -> fake API 404
        with pytest.raises(MCPError, match="internal_error"):
            await client.read_resource(f"memory://workspace/{WS}")

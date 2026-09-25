"""Test helpers: a scripted fake of the Mnemos REST API behind an httpx MockTransport."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx
from mcp import Client
from mcp.server.mcpserver import MCPServer

from mnemos_sdk import AsyncMnemosClient

WS = "11111111-1111-4111-8111-111111111111"
PROJECT = "22222222-2222-4222-8222-222222222222"
AGENT = "33333333-3333-4333-8333-333333333333"
MEM = "44444444-4444-4444-8444-444444444444"
EXP = "55555555-5555-4555-8555-555555555555"
TRACE = "66666666-6666-4666-8666-666666666666"
API_KEY = "mk_test_key"

Responder = httpx.Response | Callable[[httpx.Request], httpx.Response]


def memory_json(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": MEM,
        "organization_id": "00000000-0000-4000-8000-000000000000",
        "workspace_id": WS,
        "project_id": PROJECT,
        "agent_id": None,
        "layer": 3,
        "type": "lesson",
        "scope_type": "project",
        "scope_id": PROJECT,
        "title": "Retry flaky uploads",
        "content": "S3 uploads need 3 retries with jitter.",
        "status": "active",
        "review_state": "none",
        "confidence": 0.8,
        "trust_score": 0.7,
        "importance": 0.5,
        "utility_score": 0.6,
        "valid_from": "2026-01-01T00:00:00Z",
        "valid_until": None,
        "version": 2,
        "metadata_json": {"source_system": "ci"},
        "retrieval_count": 1,
        "last_retrieved_at": None,
        "created_by_type": "agent",
        "created_by_id": "key:1",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-02T00:00:00Z",
    }
    return {**base, **overrides}


def api_error(status: int, code: str, message: str) -> httpx.Response:
    return httpx.Response(
        status, json={"error": {"code": code, "message": message, "details": {}, "request_id": "req-1"}}
    )


@dataclass
class FakeMnemosAPI:
    """Routes ``(METHOD, path)`` to scripted responses (a list is consumed in order) and records every request."""

    routes: dict[tuple[str, str], list[Responder]] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)

    def add(self, method: str, path: str, *responses: Responder) -> None:
        self.routes.setdefault((method, path), []).extend(responses)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        queue = self.routes.get((request.method, request.url.path))
        if not queue:
            return api_error(404, "not_found", f"no fake route for {request.method} {request.url.path}")
        responder = queue.pop(0) if len(queue) > 1 else queue[0]
        return responder(request) if callable(responder) else responder

    def calls(self, method: str, path: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == method and r.url.path == path]

    @staticmethod
    def body(request: httpx.Request) -> dict[str, Any]:
        return json.loads(request.content)


def make_api_client(fake: FakeMnemosAPI, max_retries: int = 0) -> AsyncMnemosClient:
    return AsyncMnemosClient(
        "http://mnemos.test", API_KEY, transport=httpx.MockTransport(fake.handler), max_retries=max_retries
    )


@asynccontextmanager
async def connect(server: MCPServer, mode: str = "auto") -> AsyncIterator[Client]:
    """In-process MCP client session (``auto`` = modern direct dispatch, ``legacy`` = JSON-RPC over memory streams)."""
    async with Client(server, mode=mode) as client:
        yield client

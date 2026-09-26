"""Streamable HTTP transport (bearer auth, health check, full MCP round trip) and configuration."""

from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
import httpx
import httpx2
import pytest
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import MCPServer
from mcp_fakes import TRACE, WS, FakeMnemosAPI, make_api_client
from starlette.types import ASGIApp

from mnemos_mcp.config import ConfigError, Settings, is_loopback
from mnemos_mcp.server import build_http_app, create_server, main

TOKEN = "s3cret-mcp-token"
ALL_INTERFACES = "0.0.0.0"  # noqa: S104 - config values under test, nothing is bound
BASE = "http://127.0.0.1:8765"  # loopback binds enable DNS-rebinding protection: Host must be 127.0.0.1:<port>
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
}
MCP_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


@asynccontextmanager
async def running_app(token: str | None, fake_api: FakeMnemosAPI) -> AsyncIterator[tuple[MCPServer, ASGIApp]]:
    settings = Settings(workspace_id=WS, transport="streamable-http", token=token)
    server = create_server(settings, make_api_client(fake_api))
    app = build_http_app(server, settings)
    # httpx's ASGI transport does not send lifespan events, so run the session manager explicitly.
    async with server.session_manager.run():
        yield server, app


@asynccontextmanager
async def http_client(token: str | None, fake_api: FakeMnemosAPI) -> AsyncIterator[httpx.AsyncClient]:
    """Plain HTTP client wired in-process to the running MCP ASGI app."""
    async with (
        running_app(token, fake_api) as (_, app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=BASE) as http,
    ):
        yield http


@pytest.mark.anyio
async def test_healthz_is_public(fake_api: FakeMnemosAPI) -> None:
    async with http_client(TOKEN, fake_api) as http:
        resp = await http.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.anyio
@pytest.mark.parametrize("auth", [None, "Bearer wrong-token", f"Basic {TOKEN}", "Bearer ", TOKEN])
async def test_mcp_endpoint_rejects_missing_or_wrong_token(fake_api: FakeMnemosAPI, auth: str | None) -> None:
    headers = dict(MCP_HEADERS)
    if auth is not None:
        headers["authorization"] = auth
    async with http_client(TOKEN, fake_api) as http:
        resp = await http.post("/mcp", json=INITIALIZE, headers=headers)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"].startswith("Bearer")
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake_api.requests == []


@pytest.mark.anyio
async def test_mcp_endpoint_accepts_correct_token(fake_api: FakeMnemosAPI) -> None:
    async with http_client(TOKEN, fake_api) as http:
        resp = await http.post("/mcp", json=INITIALIZE, headers={**MCP_HEADERS, "authorization": f"Bearer {TOKEN}"})
    assert resp.status_code == 200
    assert "mnemos" in resp.text  # serverInfo.name in the initialize result


@pytest.mark.anyio
async def test_no_token_configured_means_open_endpoint(fake_api: FakeMnemosAPI) -> None:
    async with http_client(None, fake_api) as http:
        resp = await http.post("/mcp", json=INITIALIZE, headers=MCP_HEADERS)
    assert resp.status_code == 200


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_full_mcp_round_trip_over_streamable_http(fake_api: FakeMnemosAPI, mode: str) -> None:
    fake_api.add(
        "POST",
        "/v1/memories/search",
        httpx.Response(200, json={"items": [], "retrieval_trace_id": TRACE, "weights": {}}),
    )
    async with running_app(TOKEN, fake_api) as (_, app):
        http = httpx2.AsyncClient(transport=httpx2.ASGITransport(app), headers={"Authorization": f"Bearer {TOKEN}"})
        async with http, Client(streamable_http_client(f"{BASE}/mcp", http_client=http), mode=mode) as client:
            tools = await client.list_tools()
            result = await client.call_tool("memory_search", {"query": "uploads"})
    assert {t.name for t in tools.tools} >= {"memory_search", "memory_remember"}
    assert not result.is_error
    assert result.structured_content is not None
    assert result.structured_content["retrieval_trace_id"] == TRACE
    assert len(fake_api.calls("POST", "/v1/memories/search")) == 1


# ------------------------------------------------------------------------------------------------ configuration
def test_settings_from_env() -> None:
    s = Settings.from_env(
        {
            "MNEMOS_URL": "https://mnemos.example.com/api/",
            "MNEMOS_API_KEY": "k",
            "MNEMOS_WORKSPACE_ID": WS.upper(),
            "MNEMOS_MCP_TRANSPORT": "http",
            "MNEMOS_MCP_HOST": ALL_INTERFACES,
            "MNEMOS_MCP_PORT": "9000",
            "MNEMOS_MCP_TOKEN": TOKEN,
            "MNEMOS_MCP_PATH": "mcp",
            "MNEMOS_MCP_ALLOWED_HOSTS": "mnemos.example.com, localhost:*",
            "MNEMOS_MCP_STATELESS": "false",
        }
    )
    assert s.api_url == "https://mnemos.example.com/api"
    assert s.workspace_id == WS
    assert s.transport == "streamable-http"
    assert (s.host, s.port, s.http_path) == (ALL_INTERFACES, 9000, "/mcp")
    assert s.allowed_hosts == ("mnemos.example.com", "localhost:*")
    assert s.stateless is False
    assert TOKEN not in repr(s) and "api_key='k'" not in repr(s)  # secrets are not in repr
    s.check_http_security()


def test_log_level_falls_back_to_shared_log_level() -> None:
    assert Settings.from_env({"LOG_LEVEL": "warning"}).log_level == "WARNING"
    assert Settings.from_env({"LOG_LEVEL": "warning", "MNEMOS_MCP_LOG_LEVEL": "debug"}).log_level == "DEBUG"


def test_settings_defaults() -> None:
    s = Settings.from_env({})
    assert (s.api_url, s.transport, s.host, s.port, s.workspace_id, s.token) == (
        "http://localhost:8000",
        "stdio",
        "127.0.0.1",
        8765,
        None,
        None,
    )


@pytest.mark.parametrize(
    "env",
    [
        {"MNEMOS_MCP_TRANSPORT": "sse"},
        {"MNEMOS_WORKSPACE_ID": "not-a-uuid"},
        {"MNEMOS_MCP_PORT": "abc"},
        {"MNEMOS_MCP_PORT": "70000"},
        {"MNEMOS_MCP_STATELESS": "maybe"},
        {"MNEMOS_MCP_LOG_LEVEL": "LOUD"},
    ],
)
def test_settings_reject_invalid_values(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError):
        Settings.from_env(env)


def test_http_transport_refuses_public_bind_without_token() -> None:
    public = Settings(transport="streamable-http", host=ALL_INTERFACES)
    with pytest.raises(ConfigError, match="MNEMOS_MCP_TOKEN"):
        public.check_http_security()
    Settings(transport="streamable-http", host=ALL_INTERFACES, token=TOKEN).check_http_security()
    Settings(transport="streamable-http", host=ALL_INTERFACES, allow_unauthenticated=True).check_http_security()
    Settings(transport="streamable-http", host="127.0.0.1").check_http_security()
    Settings(transport="stdio", host=ALL_INTERFACES).check_http_security()
    assert is_loopback("localhost") and is_loopback("::1") and is_loopback("[::1]")
    assert not is_loopback(ALL_INTERFACES) and not is_loopback("mnemos.example.com")


def test_main_exits_on_unsafe_configuration(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MNEMOS_MCP_TRANSPORT", "streamable-http")
    monkeypatch.setenv("MNEMOS_MCP_HOST", ALL_INTERFACES)
    monkeypatch.delenv("MNEMOS_MCP_TOKEN", raising=False)
    monkeypatch.delenv("MNEMOS_MCP_ALLOW_UNAUTHENTICATED", raising=False)
    with pytest.raises(SystemExit) as exc:
        main([])
    assert exc.value.code == 2
    assert "refusing to serve MCP over HTTP" in capsys.readouterr().err


@pytest.mark.anyio
async def test_allowed_hosts_enable_dns_rebinding_protection(fake_api: FakeMnemosAPI) -> None:
    settings = Settings(
        workspace_id=WS,
        transport="streamable-http",
        host=ALL_INTERFACES,
        token=TOKEN,
        allowed_hosts=("mnemos.example.com",),
        allowed_origins=("https://mnemos.example.com",),
    )
    server = create_server(settings, make_api_client(fake_api))
    app = build_http_app(server, settings)
    headers = {**MCP_HEADERS, "authorization": f"Bearer {TOKEN}"}
    async with server.session_manager.run(), httpx.AsyncClient(transport=httpx.ASGITransport(app)) as http:
        good = await http.post("https://mnemos.example.com/mcp", json=INITIALIZE, headers=headers)
        evil = await http.post("http://evil.example/mcp", json=INITIALIZE, headers=headers)
    assert good.status_code == 200
    assert evil.status_code in (400, 421)


@pytest.mark.anyio
async def test_stdio_entrypoint_serves_tools() -> None:
    env = {
        **os.environ,
        "MNEMOS_URL": "http://127.0.0.1:9",
        "MNEMOS_WORKSPACE_ID": WS,
        "MNEMOS_MCP_TRANSPORT": "stdio",
        "MNEMOS_MCP_LOG_LEVEL": "WARNING",
    }
    params = StdioServerParameters(command=sys.executable, args=["-m", "mnemos_mcp"], env=env)
    with anyio.fail_after(60):
        async with Client(params) as client:
            tools = await client.list_tools()
            templates = await client.list_resource_templates()
    assert {t.name for t in tools.tools} == {
        "memory_search",
        "memory_context",
        "memory_remember",
        "memory_experience",
        "memory_feedback",
    }
    assert len(templates.resource_templates) == 3

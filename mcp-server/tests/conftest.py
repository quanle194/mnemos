"""Fixtures for the MCP server tests (helpers live in mcp_fakes.py)."""

from __future__ import annotations

import pytest
from mcp.server.mcpserver import MCPServer
from mcp_fakes import WS, FakeMnemosAPI, make_api_client

from mnemos_mcp.config import Settings
from mnemos_mcp.server import create_server


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def fake_api() -> FakeMnemosAPI:
    return FakeMnemosAPI()


@pytest.fixture
def settings() -> Settings:
    return Settings(workspace_id=WS)


@pytest.fixture
def server(fake_api: FakeMnemosAPI, settings: Settings) -> MCPServer:
    return create_server(settings, make_api_client(fake_api))

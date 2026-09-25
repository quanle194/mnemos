from __future__ import annotations

import json

import httpx
import pytest

from mnemos_sdk import ConflictError, MnemosClient, MnemosError, NotFoundError


def make(handler, **kw):  # type: ignore[no-untyped-def]
    return MnemosClient("http://api", "mnm_k_secret", transport=httpx.MockTransport(handler), **kw)


def test_auth_header_and_context_payload() -> None:
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["auth"] = req.headers["Authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"context": "", "memories": []})

    c = make(handler)
    c.context("ws", "deploy", token_budget=3000, project_id=None, agent_id="a")
    assert seen["auth"] == "Bearer mnm_k_secret"
    assert seen["body"] == {
        "workspace_id": "ws",
        "query": "deploy",
        "token_budget": 3000,
        "agent_id": "a",
        "max_items": 10,
    }


def test_writes_carry_stable_idempotency_key_across_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda s: None)
    keys = []

    def handler(req: httpx.Request) -> httpx.Response:
        keys.append(req.headers.get("Idempotency-Key"))
        if len(keys) < 3:
            return httpx.Response(503, json={"error": {"code": "unavailable", "message": "x"}})
        return httpx.Response(201, json={"experience": {"id": "e1"}})

    c = make(handler)
    assert c.experience("ws", "t", "success")["experience"]["id"] == "e1"
    assert len(keys) == 3 and len(set(keys)) == 1 and keys[0].startswith("sdk-")


def test_transport_errors_retry_then_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda s: None)
    n = {"c": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        n["c"] += 1
        raise httpx.ConnectError("down")

    c = make(handler, max_retries=2)
    with pytest.raises(httpx.ConnectError):
        c.get_memory("m")
    assert n["c"] == 3


def test_patch_is_never_retried_and_conflict_is_typed() -> None:
    n = {"c": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        n["c"] += 1
        assert req.headers["If-Match"] == '"3"'
        return httpx.Response(
            409,
            json={
                "error": {
                    "code": "conflict",
                    "message": "version mismatch",
                    "details": {"current_version": 4},
                    "request_id": "r1",
                }
            },
        )

    c = make(handler)
    with pytest.raises(ConflictError) as ei:
        c.update_memory("m", 3, content="x")
    assert ei.value.details["current_version"] == 4 and ei.value.request_id == "r1" and n["c"] == 1


def test_error_mapping() -> None:
    c = make(lambda req: httpx.Response(404, json={"error": {"code": "not_found", "message": "nope"}}))
    with pytest.raises(NotFoundError):
        c.get_memory("x")
    c2 = make(lambda req: httpx.Response(500, text="boom"))
    with pytest.raises(MnemosError) as ei:
        c2.request("GET", "/x", retry=False)
    assert ei.value.status == 500


def test_wait_for_learning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = {"exp": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.startswith("/v1/experiences"):
            calls["exp"] += 1
            status = "processed" if calls["exp"] > 1 else "pending"
            return httpx.Response(
                200,
                json={
                    "id": "e",
                    "learning": {"processing_status": status, "job_status": "x", "memories": [{"id": "m1"}]},
                },
            )
        return httpx.Response(200, json={"id": "m1", "status": "active", "review_state": "none"})

    res = make(handler).wait_for_learning("e", timeout=5)
    assert res["learning"]["memories"][0]["status"] == "active" and calls["exp"] == 2

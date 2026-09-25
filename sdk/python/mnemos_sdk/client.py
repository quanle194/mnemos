"""Mnemos Python SDK.

Retries transient failures (network errors, 429, 502-504) with exponential backoff. Unsafe writes are retried only
because every write is sent with an ``Idempotency-Key`` (auto-generated unless provided), so a retried request can
never be applied twice.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Mapping
from typing import Any

import httpx

from mnemos_sdk.errors import AuthError, ConflictError, MnemosError, NotFoundError

RETRY_STATUS = {429, 502, 503, 504}
Json = dict[str, Any]


def _clean(d: Mapping[str, Any]) -> Json:
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in d.items() if v is not None}


def _retry_after(resp: httpx.Response, default: float, cap: float = 60.0) -> float:
    """Honour Retry-After (seconds) on 429/503, bounded; otherwise exponential backoff delay."""
    value = resp.headers.get("Retry-After")
    if value:
        try:
            return min(cap, max(0.0, float(value)))
        except ValueError:
            pass
    return default


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    try:
        err = resp.json().get("error", {})
    except ValueError:
        err = {}
    cls = {409: ConflictError, 404: NotFoundError, 401: AuthError, 403: AuthError}.get(resp.status_code, MnemosError)
    raise cls(
        resp.status_code,
        err.get("code", "error"),
        err.get("message", resp.text[:300]),
        err.get("details"),
        err.get("request_id"),
    )


class _Base:
    def __init__(self, base_url: str, api_key: str | None, timeout: float, max_retries: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {"User-Agent": "mnemos-python-sdk/0.1"}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"
        self.timeout = timeout
        self.max_retries = max_retries

    @staticmethod
    def _write_headers(idempotency_key: str | None) -> dict[str, str]:
        return {"Idempotency-Key": idempotency_key or f"sdk-{uuid.uuid4()}"}


class MnemosClient(_Base):
    """Synchronous client."""

    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        api_key: str | None = None,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        super().__init__(base_url, api_key, timeout, max_retries)
        self._http = httpx.Client(base_url=self.base_url, headers=self.headers, timeout=timeout, transport=transport)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> MnemosClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        retry: bool = True,
    ) -> Any:
        delay = 0.3
        for attempt in range(self.max_retries + 1):
            try:
                resp = self._http.request(method, path, json=json, params=_clean(params or {}), headers=headers)
            except httpx.TransportError:
                if not retry or attempt >= self.max_retries:
                    raise
            else:
                if resp.status_code in RETRY_STATUS and retry and attempt < self.max_retries:
                    time.sleep(_retry_after(resp, delay))
                    delay *= 2
                    continue
                _raise_for(resp)
                return resp.json() if resp.content else None
            time.sleep(delay)
            delay *= 2
        raise RuntimeError("unreachable")

    def _write(
        self,
        method: str,
        path: str,
        body: Any,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        h = {**self._write_headers(idempotency_key), **(headers or {})}
        return self.request(method, path, json=body, headers=h)

    # ---- core ergonomics (spec: context, experience, search_memories, get_memory, feedback, dream)
    def context(
        self,
        workspace_id: str,
        query: str,
        *,
        token_budget: int = 2000,
        project_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
        memory_types: list[str] | None = None,
        max_items: int = 10,
        **extra: Any,
    ) -> Json:
        body = _clean(
            {
                "workspace_id": workspace_id,
                "query": query,
                "token_budget": token_budget,
                "project_id": project_id,
                "agent_id": agent_id,
                "session_id": session_id,
                "memory_types": memory_types,
                "max_items": max_items,
                **extra,
            }
        )
        return self.request("POST", "/v1/context", json=body)  # read-only: safe to retry

    def experience(
        self,
        workspace_id: str,
        task: str,
        outcome: str,
        *,
        observation: str = "",
        action: str = "",
        result: str = "",
        idempotency_key: str | None = None,
        **extra: Any,
    ) -> Json:
        body = _clean(
            {
                "workspace_id": workspace_id,
                "task": task,
                "outcome": outcome,
                "observation": observation,
                "action": action,
                "result": result,
                **extra,
            }
        )
        return self._write("POST", "/v1/experiences", body, idempotency_key)

    def search_memories(self, workspace_id: str, query: str, **extra: Any) -> Json:
        return self.request(
            "POST", "/v1/memories/search", json=_clean({"workspace_id": workspace_id, "query": query, **extra})
        )

    def get_memory(self, memory_id: str) -> Json:
        return self.request("GET", f"/v1/memories/{memory_id}")

    def feedback(
        self, memory_id: str, value: str, *, note: str = "", idempotency_key: str | None = None, **extra: Any
    ) -> Json:
        return self._write(
            "POST",
            f"/v1/memories/{memory_id}/feedback",
            _clean({"value": value, "note": note, **extra}),
            idempotency_key,
        )

    def dream(self, workspace_id: str, mode: str, *, idempotency_key: str | None = None) -> Json:
        return self._write("POST", "/v1/dreams", {"workspace_id": workspace_id, "mode": mode}, idempotency_key)

    # ---- additional helpers
    def get_dream(self, dream_id: str) -> Json:
        return self.request("GET", f"/v1/dreams/{dream_id}")

    def get_experience(self, experience_id: str) -> Json:
        return self.request("GET", f"/v1/experiences/{experience_id}")

    def remember(
        self,
        workspace_id: str,
        type: str,
        title: str,
        content: str,
        *,
        idempotency_key: str | None = None,
        **extra: Any,
    ) -> Json:
        """Propose a candidate memory (never trusted until validated)."""
        body = _clean({"workspace_id": workspace_id, "type": type, "title": title, "content": content, **extra})
        return self._write("POST", "/v1/memories", body, idempotency_key)

    def update_memory(self, memory_id: str, expected_version: int, **changes: Any) -> Json:
        return self.request(
            "PATCH",
            f"/v1/memories/{memory_id}",
            json=_clean(changes),
            headers={"If-Match": f'"{expected_version}"'},
            retry=False,
        )

    def memory_history(self, memory_id: str) -> list[Json]:
        return self.request("GET", f"/v1/memories/{memory_id}/history")

    def memory_evidence(self, memory_id: str) -> list[Json]:
        return self.request("GET", f"/v1/memories/{memory_id}/evidence")

    def memory_relations(self, memory_id: str) -> list[Json]:
        return self.request("GET", f"/v1/memories/{memory_id}/relations")

    def list_memories(self, **params: Any) -> Json:
        return self.request("GET", "/v1/memories", params=params)

    def events(
        self, workspace_id: str, events: list[Json], *, idempotency_key: str | None = None, **extra: Any
    ) -> Json:
        return self._write(
            "POST", "/v1/events", _clean({"workspace_id": workspace_id, "events": events, **extra}), idempotency_key
        )

    def health(self) -> Json:
        return self.request("GET", "/health/ready")

    def me(self) -> Json:
        return self.request("GET", "/v1/me")

    def bootstrap(self, bootstrap_secret: str, organization_name: str, workspace_name: str = "default") -> Json:
        return self.request(
            "POST",
            "/v1/admin/bootstrap",
            json={"organization_name": organization_name, "workspace_name": workspace_name},
            headers={"X-Bootstrap-Secret": bootstrap_secret},
            retry=False,
        )

    def wait_for_learning(self, experience_id: str, timeout: float = 30.0, poll: float = 0.3) -> Json:
        """Poll until the experience was processed and its candidates left the pending validation state."""
        deadline = time.monotonic() + timeout
        while True:
            exp = self.get_experience(experience_id)
            learning = exp.get("learning") or {}
            if learning.get("processing_status") == "processed":
                mems = [self.get_memory(m["id"]) for m in learning.get("memories", [])]
                if all(m["status"] != "candidate" or m["review_state"] != "none" for m in mems):
                    exp["learning"]["memories"] = mems
                    return exp
            if learning.get("job_status") == "dead":
                raise MnemosError(500, "learning_failed", "extraction job is dead")
            if time.monotonic() > deadline:
                raise TimeoutError(f"learning for {experience_id} not finished after {timeout}s")
            time.sleep(poll)


class AsyncMnemosClient(_Base):
    """Asynchronous client with the same surface as MnemosClient (core methods)."""

    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        api_key: str | None = None,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(base_url, api_key, timeout, max_retries)
        self._http = httpx.AsyncClient(
            base_url=self.base_url, headers=self.headers, timeout=timeout, transport=transport
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncMnemosClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        retry: bool = True,
    ) -> Any:
        delay = 0.3
        for attempt in range(self.max_retries + 1):
            try:
                resp = await self._http.request(method, path, json=json, params=_clean(params or {}), headers=headers)
            except httpx.TransportError:
                if not retry or attempt >= self.max_retries:
                    raise
            else:
                if resp.status_code in RETRY_STATUS and retry and attempt < self.max_retries:
                    wait = _retry_after(resp, delay)
                    await asyncio.sleep(wait)
                    delay *= 2
                    continue
                _raise_for(resp)
                return resp.json() if resp.content else None
            await asyncio.sleep(delay)
            delay *= 2
        raise RuntimeError("unreachable")

    async def _write(self, method: str, path: str, body: Any, idempotency_key: str | None = None) -> Any:
        return await self.request(method, path, json=body, headers=self._write_headers(idempotency_key))

    async def context(self, workspace_id: str, query: str, *, token_budget: int = 2000, **extra: Any) -> Json:
        return await self.request(
            "POST",
            "/v1/context",
            json=_clean({"workspace_id": workspace_id, "query": query, "token_budget": token_budget, **extra}),
        )

    async def experience(
        self, workspace_id: str, task: str, outcome: str, *, idempotency_key: str | None = None, **extra: Any
    ) -> Json:
        return await self._write(
            "POST",
            "/v1/experiences",
            _clean({"workspace_id": workspace_id, "task": task, "outcome": outcome, **extra}),
            idempotency_key,
        )

    async def search_memories(self, workspace_id: str, query: str, **extra: Any) -> Json:
        return await self.request(
            "POST", "/v1/memories/search", json=_clean({"workspace_id": workspace_id, "query": query, **extra})
        )

    async def get_memory(self, memory_id: str) -> Json:
        return await self.request("GET", f"/v1/memories/{memory_id}")

    async def feedback(
        self, memory_id: str, value: str, *, note: str = "", idempotency_key: str | None = None, **extra: Any
    ) -> Json:
        return await self._write(
            "POST",
            f"/v1/memories/{memory_id}/feedback",
            _clean({"value": value, "note": note, **extra}),
            idempotency_key,
        )

    async def dream(self, workspace_id: str, mode: str, *, idempotency_key: str | None = None) -> Json:
        return await self._write("POST", "/v1/dreams", {"workspace_id": workspace_id, "mode": mode}, idempotency_key)

    async def remember(
        self,
        workspace_id: str,
        type: str,
        title: str,
        content: str,
        *,
        idempotency_key: str | None = None,
        **extra: Any,
    ) -> Json:
        return await self._write(
            "POST",
            "/v1/memories",
            _clean({"workspace_id": workspace_id, "type": type, "title": title, "content": content, **extra}),
            idempotency_key,
        )

    async def get_experience(self, experience_id: str) -> Json:
        return await self.request("GET", f"/v1/experiences/{experience_id}")

"""OpenAI-compatible HTTP providers (OpenAI, vLLM, LM Studio, LiteLLM, llama.cpp server...)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import structlog
from pydantic import BaseModel, ValidationError

from app.providers.base import ProviderError
from app.providers.prompts import system_prompt
from app.providers.schemas import TASK_SCHEMAS

log = structlog.get_logger(__name__)
RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


async def _post_with_retry(client: httpx.AsyncClient, url: str, body: dict[str, Any], retries: int) -> Any:
    delay = 0.5
    for attempt in range(retries + 1):
        try:
            resp = await client.post(url, json=body)
        except httpx.TransportError as exc:
            if attempt >= retries:
                raise ProviderError(f"transport error calling {url}: {exc}") from exc
        else:
            if resp.status_code < 400:
                return resp.json()
            if resp.status_code not in RETRYABLE_STATUS or attempt >= retries:
                raise ProviderError(f"{url} returned HTTP {resp.status_code}: {resp.text[:300]}")
        await asyncio.sleep(delay)
        delay *= 2
    raise ProviderError("unreachable")


def extract_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in model output")
    obj = json.loads(text[start : end + 1])
    if not isinstance(obj, dict):
        raise ValueError("model output is not a JSON object")
    return obj


class OpenAICompatibleLLM:
    name = "openai"

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 60.0, max_retries: int = 2,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.AsyncClient(base_url=base_url.rstrip("/"), headers=headers, timeout=timeout,
                                         transport=transport)
        self.model = model
        self.max_retries = max_retries

    async def aclose(self) -> None:
        await self._client.aclose()

    async def generate_json(self, task: str, payload: dict[str, Any]) -> BaseModel:
        schema = TASK_SCHEMAS[task]
        messages: list[dict[str, str]] = [
            {"role": "system", "content": system_prompt(task)},
            {"role": "user", "content": json.dumps(payload, default=str)},
        ]
        last_error = ""
        for _ in range(self.max_retries + 1):
            body = {"model": self.model, "messages": messages, "temperature": 0,
                    "response_format": {"type": "json_object"}}
            data = await _post_with_retry(self._client, "/chat/completions", body, self.max_retries)
            try:
                content = data["choices"][0]["message"]["content"] or ""
                return schema.model_validate(extract_json_object(content))
            except (KeyError, IndexError, ValueError, ValidationError) as exc:
                last_error = str(exc)[:500]
                log.warning("llm_schema_validation_failed", task=task, error=last_error)
                messages = [*messages[:2], {"role": "assistant", "content": str(data)[:2000]},
                            {"role": "user", "content": f"Invalid output ({last_error}). Return only valid JSON."}]
        raise ProviderError(f"LLM output failed schema validation for task {task}: {last_error}")


class OpenAICompatibleEmbeddings:
    name = "openai"

    def __init__(self, base_url: str, api_key: str, model: str, dimensions: int, timeout: float = 60.0,
                 max_retries: int = 2, transport: httpx.AsyncBaseTransport | None = None) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.AsyncClient(base_url=base_url.rstrip("/"), headers=headers, timeout=timeout,
                                         transport=transport)
        self.model = model
        self.dimensions = dimensions
        self.max_retries = max_retries

    async def aclose(self) -> None:
        await self._client.aclose()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        data = await _post_with_retry(self._client, "/embeddings", {"model": self.model, "input": texts},
                                      self.max_retries)
        vectors = [item["embedding"] for item in sorted(data["data"], key=lambda d: d["index"])]
        for v in vectors:
            if len(v) != self.dimensions:
                raise ProviderError(f"embedding dimension {len(v)} != configured {self.dimensions}")
        return vectors

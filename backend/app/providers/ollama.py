"""Native Ollama providers (local models)."""

from __future__ import annotations

import json
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from app.providers.base import ProviderError
from app.providers.openai_compat import _post_with_retry, extract_json_object
from app.providers.prompts import system_prompt
from app.providers.schemas import TASK_SCHEMAS


class OllamaLLM:
    name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout: float = 120.0,
        max_retries: int = 2,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=(base_url or "http://ollama:11434").rstrip("/"), timeout=timeout, transport=transport
        )
        self.model = model
        self.max_retries = max_retries

    async def aclose(self) -> None:
        await self._client.aclose()

    async def generate_json(self, task: str, payload: dict[str, Any]) -> BaseModel:
        schema = TASK_SCHEMAS[task]
        body = {
            "model": self.model,
            "stream": False,
            "format": schema.model_json_schema(),
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system_prompt(task)},
                {"role": "user", "content": json.dumps(payload, default=str)},
            ],
        }
        last = ""
        for _ in range(self.max_retries + 1):
            data = await _post_with_retry(self._client, "/api/chat", body, self.max_retries)
            try:
                return schema.model_validate(extract_json_object(data["message"]["content"]))
            except (KeyError, ValueError, ValidationError) as exc:
                last = str(exc)[:300]
        raise ProviderError(f"ollama output failed schema validation for {task}: {last}")


class OllamaEmbeddings:
    name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        dimensions: int,
        timeout: float = 120.0,
        max_retries: int = 2,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=(base_url or "http://ollama:11434").rstrip("/"), timeout=timeout, transport=transport
        )
        self.model = model
        self.dimensions = dimensions
        self.max_retries = max_retries

    async def aclose(self) -> None:
        await self._client.aclose()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        data = await _post_with_retry(
            self._client, "/api/embed", {"model": self.model, "input": texts}, self.max_retries
        )
        vectors = data["embeddings"]
        for v in vectors:
            if len(v) != self.dimensions:
                raise ProviderError(f"embedding dimension {len(v)} != configured {self.dimensions}")
        return vectors

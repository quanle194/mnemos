"""Provider ports."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel


class ProviderError(RuntimeError):
    """Raised when a provider fails; jobs treat it as retryable."""


@runtime_checkable
class LLMProvider(Protocol):
    name: str

    async def generate_json(self, task: str, payload: dict[str, Any]) -> BaseModel:
        """Run a structured task. Returns an instance of TASK_SCHEMAS[task] (validated)."""
        ...

    async def aclose(self) -> None: ...


@runtime_checkable
class EmbeddingProvider(Protocol):
    name: str
    dimensions: int

    async def embed(self, texts: list[str]) -> list[list[float]]: ...

    async def aclose(self) -> None: ...

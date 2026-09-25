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


async def structured[T: BaseModel](llm: LLMProvider, task: str, payload: dict[str, Any], schema: type[T]) -> T:
    """Typed wrapper around LLMProvider.generate_json (asserts the validated schema type)."""
    out = await llm.generate_json(task, payload)
    if not isinstance(out, schema):
        raise ProviderError(f"provider returned {type(out).__name__} for task {task}, expected {schema.__name__}")
    return out

from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings
from app.domain.ranking import cosine
from app.providers.base import ProviderError
from app.providers.factory import build_embedder, build_llm
from app.providers.fake import FakeEmbeddingProvider, FakeLLMProvider
from app.providers.ollama import OllamaEmbeddings, OllamaLLM
from app.providers.openai_compat import OpenAICompatibleEmbeddings, OpenAICompatibleLLM, extract_json_object
from app.providers.schemas import ExtractionOut


async def test_fake_embeddings_deterministic_and_similarity_preserving() -> None:
    e = FakeEmbeddingProvider(384)
    a, b, c = await e.embed(
        ["deploy billing api to staging", "deploying the billing api to staging", "bake a chocolate cake"]
    )
    assert a == (await e.embed(["deploy billing api to staging"]))[0]
    assert len(a) == 384 and abs(sum(x * x for x in a) - 1) < 1e-9
    assert cosine(a, b) > 0.6 > cosine(a, c)


async def test_fake_llm_extraction_success_failure_and_explicit() -> None:
    llm = FakeLLMProvider()
    ok = await llm.generate_json(
        "memory_extraction",
        {
            "experience": {
                "id": "e1",
                "task": "Deploy api",
                "observation": "Migration failed with a lock timeout.",
                "action": "Used --lock-timeout=5s",
                "result": "Deployed",
                "outcome": "success",
                "confidence": 0.8,
            }
        },
    )
    assert isinstance(ok, ExtractionOut)
    assert ok.candidates[0].type == "lesson" and "What worked: Used --lock-timeout=5s" in ok.candidates[0].content
    assert ok.candidates[0].evidence_ids == ["e1"]
    fail = await llm.generate_json(
        "memory_extraction",
        {
            "experience": {
                "id": "e2",
                "task": "Deploy api",
                "observation": "Timed out",
                "action": "Ran migrations during peak",
                "result": "Rollback",
                "outcome": "failure",
            }
        },
    )
    assert fail.candidates[0].type == "warning"  # type: ignore[attr-defined]
    trivial = await llm.generate_json(
        "memory_extraction", {"experience": {"id": "e3", "task": "hi", "outcome": "success"}}
    )
    assert trivial.candidates == []  # type: ignore[attr-defined]
    explicit = await llm.generate_json(
        "memory_extraction",
        {
            "experience": {
                "id": "e4",
                "task": "t",
                "outcome": "success",
                "metadata": {"lessons": ["Always pin base image digests."]},
            }
        },
    )
    assert explicit.candidates[0].type == "rule"  # type: ignore[attr-defined]


async def test_fake_llm_other_tasks() -> None:
    llm = FakeLLMProvider()
    exps = [
        {
            "id": str(i),
            "task": "Build image",
            "action": f"attempt {i}",
            "observation": "pip timed out",
            "result": "r",
            "outcome": "failure" if i < 2 else "success",
            "importance": 0.5,
        }
        for i in range(3)
    ]
    refl = await llm.generate_json("reflection", {"experiences": exps})
    assert refl.lessons and set(refl.lessons[0].evidence_ids) == {"0", "1", "2"}  # type: ignore[attr-defined]
    pat = await llm.generate_json("pattern_summary", {"kind": "failure", "experiences": exps[:2]})
    assert pat.type == "warning"  # type: ignore[attr-defined]
    judge = await llm.generate_json(
        "contradiction_judgment", {"a": "Use pnpm instead of npm", "b": "Use npm instead of pnpm"}
    )
    assert judge.relation == "contradicts"  # type: ignore[attr-defined]
    summ = await llm.generate_json("episode_summary", {"experiences": exps})
    assert summ.outcome == "success"  # type: ignore[attr-defined]


def _mock(handler):  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


async def test_openai_llm_validates_and_retries_bad_json() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        assert request.headers["Authorization"] == "Bearer k"
        assert body["response_format"] == {"type": "json_object"}
        content = "not json" if len(calls) == 1 else '```json\n{"candidates": []}\n```'
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    llm = OpenAICompatibleLLM("http://llm/v1", "k", "m", transport=_mock(handler))
    out = await llm.generate_json("memory_extraction", {"experience": {"id": "x"}})
    assert out.candidates == [] and len(calls) == 2  # type: ignore[attr-defined]
    assert "untrusted data" in calls[0]["messages"][0]["content"]
    await llm.aclose()


async def test_openai_llm_retries_http_and_fails_cleanly() -> None:
    n = {"c": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        n["c"] += 1
        return httpx.Response(503, text="overloaded")

    llm = OpenAICompatibleLLM("http://llm/v1", "", "m", max_retries=1, transport=_mock(handler))
    with pytest.raises(ProviderError):
        await llm.generate_json("episode_summary", {"experiences": []})
    assert n["c"] == 2
    await llm.aclose()


async def test_openai_embeddings_dimension_check() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["input"]
        return httpx.Response(
            200, json={"data": [{"index": i, "embedding": [0.1] * 4} for i in reversed(range(len(texts)))]}
        )

    emb = OpenAICompatibleEmbeddings("http://e/v1", "k", "m", 4, transport=_mock(handler))
    assert len(await emb.embed(["a", "b"])) == 2
    bad = OpenAICompatibleEmbeddings("http://e/v1", "k", "m", 8, transport=_mock(handler))
    with pytest.raises(ProviderError):
        await bad.embed(["a"])
    await emb.aclose()
    await bad.aclose()


async def test_ollama_providers() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/chat":
            body = json.loads(request.content)
            assert body["format"]["type"] == "object"
            return httpx.Response(
                200,
                json={"message": {"content": json.dumps({"summary": "s", "outcome": "success", "importance": 0.4})}},
            )
        return httpx.Response(200, json={"embeddings": [[0.0, 1.0]]})

    llm = OllamaLLM("http://ollama:11434", "llama", transport=_mock(handler))
    out = await llm.generate_json("episode_summary", {"experiences": []})
    assert out.summary == "s"  # type: ignore[attr-defined]
    emb = OllamaEmbeddings("http://ollama:11434", "nomic", 2, transport=_mock(handler))
    assert await emb.embed(["x"]) == [[0.0, 1.0]]
    await llm.aclose()
    await emb.aclose()


def test_extract_json_object() -> None:
    assert extract_json_object('prefix {"a": 1} suffix') == {"a": 1}
    with pytest.raises(ValueError):
        extract_json_object("no json")


def test_factory() -> None:
    s = Settings(llm_provider="fake", embedding_provider="fake", embedding_dimensions=64)
    assert build_llm(s).name == "fake" and build_embedder(s).dimensions == 64
    s2 = Settings(
        llm_provider="openai",
        llm_base_url="http://x/v1",
        llm_model="m",
        embedding_provider="ollama",
        embedding_model="nomic",
        embedding_dimensions=768,
    )
    assert build_llm(s2).name == "openai" and build_embedder(s2).name == "ollama"

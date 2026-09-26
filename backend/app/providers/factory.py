from __future__ import annotations

from app.config import Settings
from app.providers.base import EmbeddingProvider, LLMProvider
from app.providers.fake import FakeEmbeddingProvider, FakeLLMProvider
from app.providers.ollama import OllamaEmbeddings, OllamaLLM
from app.providers.openai_compat import OpenAICompatibleEmbeddings, OpenAICompatibleLLM


def build_llm(settings: Settings) -> LLMProvider:
    match settings.llm_provider:
        case "fake":
            return FakeLLMProvider()
        case "openai":
            return OpenAICompatibleLLM(
                settings.llm_base_url or "https://api.openai.com/v1",
                settings.llm_api_key,
                settings.llm_model,
                settings.llm_timeout_seconds,
                settings.llm_max_retries,
            )
        case "ollama":
            return OllamaLLM(
                settings.llm_base_url, settings.llm_model, settings.llm_timeout_seconds, settings.llm_max_retries
            )
    raise ValueError(settings.llm_provider)


def build_embedder(settings: Settings) -> EmbeddingProvider:
    match settings.embedding_provider:
        case "fake":
            return FakeEmbeddingProvider(settings.embedding_dimensions)
        case "openai":
            return OpenAICompatibleEmbeddings(
                settings.embedding_base_url or "https://api.openai.com/v1",
                settings.embedding_api_key,
                settings.embedding_model,
                settings.embedding_dimensions,
                settings.llm_timeout_seconds,
                settings.llm_max_retries,
            )
        case "ollama":
            return OllamaEmbeddings(
                settings.embedding_base_url,
                settings.embedding_model,
                settings.embedding_dimensions,
                settings.llm_timeout_seconds,
                settings.llm_max_retries,
            )
    raise ValueError(settings.embedding_provider)

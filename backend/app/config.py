"""Validated application settings (environment driven)."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_RANK_WEIGHTS: dict[str, float] = {
    "relevance": 0.55,
    "importance": 0.12,
    "trust": 0.13,
    "recency": 0.08,
    "utility": 0.12,
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    app_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    log_json: bool = True
    service_name: str = "mnemos"

    database_url: str = "postgresql+asyncpg://mnemos:mnemos@localhost:5432/mnemos"
    db_pool_size: int = 10
    db_max_overflow: int = 10
    redis_url: str = "redis://localhost:6379/0"

    public_web_url: str = "http://localhost:3000"
    public_api_url: str = "http://localhost:8000"
    cors_allowed_origins: str = ""
    allowed_hosts: str = "*"

    api_bootstrap_secret: str = "change-me"  # noqa: S105 - dev default, rejected in production
    api_key_pepper: str = ""

    llm_provider: Literal["fake", "openai", "ollama"] = "fake"
    embedding_provider: Literal["fake", "openai", "ollama"] = "fake"
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout_seconds: float = 60.0
    llm_max_retries: int = 2
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_model: str = "fake-embedding"
    embedding_dimensions: int = 384

    # request limits
    max_request_bytes: int = 256_000
    max_text_field_chars: int = 20_000
    rate_limit_per_minute: int = 600
    bootstrap_rate_limit: int = 20

    # learning policy
    min_candidate_confidence: float = 0.3
    auto_promote_min_confidence: float = 0.55
    auto_promote_min_trust: float = 0.5
    dedup_threshold: float = 0.9
    related_threshold: float = 0.55
    contradiction_similarity_threshold: float = 0.45
    feedback_dispute_threshold: int = 2
    feedback_outdated_threshold: int = 2

    # retrieval
    rank_weights_json: str = ""
    recency_half_life_days: float = 30.0
    context_dedup_threshold: float = 0.95
    retrieval_candidate_k: int = 50
    default_token_budget: int = 2000

    # dreaming / lifecycle
    dream_interval_minutes: int = 60
    dream_experience_threshold: int = 20
    dream_memory_growth_threshold: int = 50
    dream_window_limit: int = 200
    dream_auto_apply: bool = True
    dream_dedup_threshold: float = 0.85
    dream_compression_threshold: float = 0.72
    dream_cluster_threshold: float = 0.6
    lifecycle_interval_minutes: int = 15
    lifecycle_cold_after_days: int = 90
    lifecycle_cold_utility_threshold: float = 0.2

    # jobs
    job_max_attempts: int = 5
    job_lease_seconds: int = 120
    worker_concurrency: int = 4
    worker_poll_seconds: float = 2.0
    scheduler_enabled: bool = True

    metrics_enabled: bool = True
    otel_exporter_otlp_endpoint: str = ""

    rank_weights: dict[str, float] = Field(default_factory=lambda: dict(DEFAULT_RANK_WEIGHTS))

    @field_validator("embedding_dimensions")
    @classmethod
    def _dims(cls, v: int) -> int:
        if not 8 <= v <= 4096:
            raise ValueError("EMBEDDING_DIMENSIONS must be between 8 and 4096")
        return v

    @model_validator(mode="after")
    def _derive(self) -> Settings:
        if self.rank_weights_json:
            parsed = json.loads(self.rank_weights_json)
            unknown = set(parsed) - set(DEFAULT_RANK_WEIGHTS)
            if unknown:
                raise ValueError(f"unknown rank weight keys: {sorted(unknown)}")
            self.rank_weights = {**DEFAULT_RANK_WEIGHTS, **{k: float(v) for k, v in parsed.items()}}
        if self.app_env == "production":
            problems = []
            if self.api_bootstrap_secret in ("", "change-me") or len(self.api_bootstrap_secret) < 24:
                problems.append("API_BOOTSTRAP_SECRET must be set to a random value (>=24 chars)")
            if self.llm_provider != "fake" and not self.llm_base_url and self.llm_provider == "openai":
                problems.append("LLM_BASE_URL is required for the openai provider")
            if problems:
                raise ValueError("; ".join(problems))
        return self

    @property
    def pepper(self) -> bytes:
        return (self.api_key_pepper or self.api_bootstrap_secret).encode()

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

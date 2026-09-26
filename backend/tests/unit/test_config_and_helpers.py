from __future__ import annotations

import numpy as np
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.modules.dreaming_service import _clusters, _merge_contents
from app.modules.feedback_service import apply_delta
from app.modules.lifecycle_service import decay_score
from app.modules.retrieval_service import build_tsquery


def test_production_requires_strong_secret() -> None:
    with pytest.raises(ValidationError):
        Settings(app_env="production", api_bootstrap_secret="change-me")
    s = Settings(app_env="production", api_bootstrap_secret="x" * 32)
    assert s.pepper == b"x" * 32


def test_rank_weights_override_and_validation() -> None:
    s = Settings(rank_weights_json='{"utility": 0.3}')
    assert s.rank_weights["utility"] == 0.3 and s.rank_weights["relevance"] == 0.55
    with pytest.raises(ValidationError):
        Settings(rank_weights_json='{"bogus": 1}')
    with pytest.raises(ValidationError):
        Settings(embedding_dimensions=2)


def test_apply_delta_bounds() -> None:
    assert apply_delta(0.5, 0.2) == 0.6
    assert apply_delta(0.5, -0.2) == 0.4
    assert apply_delta(1.0, 0.5) == 1.0 and apply_delta(0.0, -0.5) == 0.0


def test_decay_score() -> None:
    hot = decay_score(importance=0.9, utility=0.9, age_days=1, days_since_use=0, half_life_days=30)
    cold = decay_score(importance=0.1, utility=0.1, age_days=400, days_since_use=365, half_life_days=30)
    assert hot > 0.8 > 0.2 > cold


def test_clusters_respect_threshold_and_groups() -> None:
    v = np.array([[1, 0], [0.99, 0.1], [0, 1], [0.98, 0.05]])
    assert _clusters(v, 0.95) == [[0, 1, 3], [2]]
    assert _clusters(v, 0.95, groups=["a", "b", "a", "a"]) == [[0, 3], [1], [2]]


def test_merge_contents_preserves_distinct_sentences() -> None:
    out = _merge_contents(
        [
            {"content": "Enable cache mount. It avoids timeouts."},
            {"content": "Enable cache mount. Pin the base image digest."},
        ],
        "Enable cache mount. It avoids timeouts.",
    )
    assert "Pin the base image digest" in out and out.count("Enable cache mount") == 1


def test_build_tsquery_sanitizes() -> None:
    assert build_tsquery("Deploy the billing-api; DROP TABLE x --") == "deploy | billing | api | drop | table"
    assert build_tsquery("the a of") == ""


def test_tracing_disabled_without_endpoint() -> None:
    from app.observability.tracing import current_trace_id, setup_tracing

    assert setup_tracing(Settings(), "t") is False
    assert current_trace_id() is None


def test_tracing_enabled_with_endpoint() -> None:
    from fastapi import FastAPI

    from app.observability.tracing import setup_tracing

    assert setup_tracing(Settings(otel_exporter_otlp_endpoint="http://127.0.0.1:4318"), "t", app=FastAPI()) is True

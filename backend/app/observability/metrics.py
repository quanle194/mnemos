"""Prometheus metrics (exposed at /metrics on the API and the worker health port)."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

REQUEST_LATENCY = Histogram("mnemos_http_request_seconds", "HTTP request latency", ["method", "route", "status"])
REQUEST_ERRORS = Counter("mnemos_http_errors_total", "HTTP 5xx responses", ["route"])
RETRIEVAL_LATENCY = Histogram("mnemos_retrieval_seconds", "Retrieval/context latency", ["kind"])
RETRIEVAL_CANDIDATES = Histogram("mnemos_retrieval_candidates", "Candidates considered per retrieval",
                                 buckets=(0, 1, 5, 10, 25, 50, 100, 200))
RETRIEVAL_SELECTED = Histogram("mnemos_retrieval_selected", "Memories selected per context",
                               buckets=(0, 1, 2, 5, 10, 20, 50))
CONTEXT_TOKENS = Histogram("mnemos_context_tokens", "Estimated context tokens",
                           buckets=(0, 100, 250, 500, 1000, 2000, 4000, 8000, 16000))
STALE_MEMORY_SELECTED = Counter("mnemos_stale_memory_selected_total", "Non-retrievable memories selected (must be 0)")
EXPERIENCES_INGESTED = Counter("mnemos_experiences_total", "Experiences ingested", ["outcome"])
CANDIDATES_EXTRACTED = Counter("mnemos_candidates_extracted_total", "Candidate memories extracted")
VALIDATION_DECISIONS = Counter("mnemos_validation_decisions_total", "Validation decisions", ["decision"])
CONFLICTS_OPENED = Counter("mnemos_conflicts_opened_total", "Conflicts opened")
FEEDBACK_TOTAL = Counter("mnemos_feedback_total", "Feedback received", ["value"])
DREAM_DURATION = Histogram("mnemos_dream_seconds", "Dream job duration", ["mode"])
DREAM_COMPRESSION_RATIO = Gauge("mnemos_dream_compression_ratio", "Last compression/dedup ratio", ["mode"])
JOBS_PROCESSED = Counter("mnemos_jobs_total", "Jobs processed", ["kind", "outcome"])
JOB_RETRIES = Counter("mnemos_job_retries_total", "Job retries", ["kind"])
JOBS_DEAD = Counter("mnemos_jobs_dead_total", "Jobs moved to dead letter", ["kind"])
QUEUE_DEPTH = Gauge("mnemos_queue_depth", "Jobs waiting", ["status"])
POISONING_FLAGGED = Counter("mnemos_poisoning_flagged_total", "Candidates flagged by injection detector")

# Implementation report

Status: all required V1 scope implemented and verified (see `artifacts/test-report.md`,
`artifacts/deployment-report.md`, traceability in `docs/IMPLEMENTATION_STATUS.md`).

## Architecture
Modular monolith (ADR 0001): FastAPI API + background worker/scheduler from one Python package, PostgreSQL 16 +
pgvector as the system of record, Redis for wake-ups/rate limits/locks/heartbeats. The job queue is a Postgres
transactional outbox with SKIP LOCKED leasing, retries with backoff, dead letters and lease recovery (ADR 0002).
Services always receive an explicit tenant `Principal`; cross-tenant ids return 404 (ADR 0003).

| Layer | Implementation |
|---|---|
| L0 events | `events` (DB trigger forbids UPDATE), redacted payloads |
| L1 working memory | `working_memories` with TTL, upsert per (workspace, agent, session, key), purged by lifecycle |
| L2 episodes | per session/task trajectory summary (LLM `episode_summary`) + embedding |
| L3 semantic | `memories` layer 3: 13 types, scoped org/workspace/project/agent/session |
| L4 organizational | layer 4 via audited `POST /memories/{id}/promote` (memory:review) |

Governance: status machine candidate -> validated -> active -> disputed/superseded -> archived, rejected terminal;
every transition writes `memory_versions` + `audit_logs`; optimistic concurrency (`If-Match`/ETag, 409/428);
evidence table (event/episode/experience/user_statement/document/tool_result/memory/feedback) and relation graph
(supports, contradicts, supersedes, derived_from, related_to, generalizes, specializes). Trust kept as separate
confidence / trust / importance / utility fields (docs/09 section 2).

Learning: extraction (LLM, schema-validated) -> candidate with evidence -> validation (related memories by vector +
content hash, rule-based + LLM contradiction judgement, injection assessment) -> policy decision promote / merge /
reject / dispute (conflict) / require_review (ADR 0004, `app/domain/policy.py`). Conflicts resolved manually or by a
conservative auto-policy. Dreaming (docs/04): reflection, deduplication, pattern, contradiction, generalization,
compression; checkpoints, window-hash idempotency, leader-locked scheduler with interval/event-count/growth triggers.
Lifecycle: expiry, cold archival with retention score, working-memory purge; evidence/history never deleted.

Retrieval (ADR 0006): vector top-K + full-text top-K under tenant/scope-chain/status/temporal filters; score
breakdown (relevance, importance, trust x confidence, recency, utility, scope bonus) with configurable weights;
MMR dedupe; token-budget packing; non-instruction context header; retrieval traces + per-memory usage.

Security/observability: API keys (HMAC-peppered hashes), RBAC roles admin/maintainer/agent/viewer, workspace-scoped
keys, rate limits (per key, bootstrap per IP), body/field size limits, secret redaction before persistence and in
logs, poisoning detector + trust boundaries, idempotency keys, structured JSON logs with request/job/trace ids,
Prometheus metrics (API `/metrics`, worker `:8001/metrics`), optional OpenTelemetry (OTLP) tracing,
`/health/live` + `/health/ready` (db, pgvector, migration, redis, workers, queue depth).

Providers (ADR 0005): deterministic fake LLM/embeddings, OpenAI-compatible HTTP, native Ollama; schema validation
with bounded retries; typed `structured()` helper.

Interfaces: REST (`docs/openapi.json`), Python SDK (sync/async, idempotent retries, Retry-After), TypeScript SDK,
MCP server (5 tools, 3 resources, stdio + token-protected streamable HTTP), `mnemos` CLI, React dashboard with the
11 specified screens, learning eval, Playwright E2E.

Infrastructure: multi-stage non-root images, dev + prod Compose, Caddy edge with automatic HTTPS or HTTP-only mode,
init-env/bootstrap-ubuntu/deploy/upgrade(rollback)/backup/restore/backup-test/smoke scripts, systemd backup timer,
`docs/RUNBOOK.md`.

## How the work was done
Backend, tests, eval and integration by the principal engineer; dashboard, TS SDK + MCP server and
infrastructure were built in parallel by delegated engineers against the frozen OpenAPI contract, then reviewed,
re-verified and integrated (defects found during integration and fixed: Makefile one-shell failure masking,
`instead of` misread as a supersede signal, working-memory schema default, dashboard login race in the E2E spec,
name-based project lookup missing on read paths, tests reading a local `.env`, worker health server fighting the
worker's signal handling, async SDK ignoring Retry-After).

## Known limitations / future work
- No Postgres row-level security (isolation enforced and tested in the service layer; ADR 0003).
- Token counts are chars/4 estimates; eval uses a simulated agent + fake providers (clearly labelled).
- Embedding dimension is fixed at first migration; changing models needs a re-embedding migration.
- Auth is API-key based; OIDC can plug into the `Principal` abstraction.
- Real domain/TLS, ufw, systemd timer and paid providers are operator inputs (see deployment report).

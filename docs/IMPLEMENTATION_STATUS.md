# Implementation Status - Requirements Traceability Matrix

Last updated: 2026-09-25 (loop iteration 1). States: DONE (implemented + evidence), IN PROGRESS, TODO.
Evidence commands are listed so every row can be re-verified. Reports: `artifacts/*.md`.

## Environment notes (build sandbox)
- Docker daemon started manually (`dockerd`); Docker Hub rate-limited -> daemon uses `mirror.gcr.io` pull-through
  mirror (`/etc/docker/daemon.json`). Repo keeps canonical image names.
- Dev/test Postgres (pgvector 0.8.0-pg16) on 127.0.0.1:55432 and Redis on 127.0.0.1:56379 (`make test-db`).

## Product requirements
| Requirement (spec) | State | Evidence / location | Next |
|---|---|---|---|
| FastAPI backend, `/v1` API baseline (00, 03) | DONE | `backend/app/api`, `docs/openapi.json` | - |
| Alembic migrations, clean DB up/down (02, 06) | DONE | `backend/alembic`, `tests/integration/test_migrations.py` (upgrade->downgrade->upgrade + `alembic check`) | - |
| PostgreSQL + pgvector, HNSW + GIN FTS indexes (02) | DONE | `app/db/models.py`, migration 0001 | - |
| Redis queue coordination (wake-ups, rate limit, locks, heartbeats) (01) | DONE | `app/redis_client.py`, ADR 0002 | - |
| Durable idempotent jobs, retries, dead letter, lease recovery (01, 06) | DONE | `app/jobs/*`, `test_jobs_and_persistence.py` | - |
| L0 events immutable (DB trigger) | DONE | migration trigger, `test_events_are_immutable...` | - |
| L1 working memory TTL | DONE | `events_service.py`, test | - |
| L2 episodes from experiences | DONE | `experience_service.upsert_episode`, isolation test uses episode | - |
| L3 semantic memory / L4 organizational (layer=4, promote endpoint, review perm) | DONE | `memories.py:promote_l4`, RBAC tests | - |
| Experience ingestion + redaction + source trust | DONE | `experience_service.py`, `test_secrets_are_redacted...` | - |
| Evidence/provenance + relation graph | DONE | `memory_service.py`, `/evidence`, `/relations`, `/graph` | - |
| Versioning + optimistic concurrency (If-Match/409/428) | DONE | `apply_changes`, `test_concurrent_patch_exactly_one_wins` | - |
| Extraction, validation, promote/merge/reject/dispute/review, superseding | DONE | `learning_service.py`, `domain/policy.py`, tests | - |
| Contradiction detection (rule + LLM judge) | DONE | `domain/contradiction.py`, conflict tests | - |
| Dreaming: reflection, dedup, pattern, contradiction, generalization, compression; checkpoints; window idempotency; scheduling | DONE | `dreaming_service.py`, `test_dreaming_lifecycle.py` | - |
| Lifecycle: expiry, cold archival, decay score, working-memory purge | DONE | `lifecycle_service.py`, tests | - |
| Hybrid retrieval, score breakdown, MMR dedupe, token budget, traces | DONE | `retrieval_service.py`, ADR 0006 | - |
| Feedback & utility learning | DONE | `feedback_service.py`, tests | - |
| Multi-tenant auth, RBAC, audit logs, poisoning defenses | DONE | ADR 0003/0004, isolation/RBAC/poisoning tests | - |
| Providers: fake + OpenAI-compatible + Ollama | DONE | `app/providers`, `tests/unit/test_providers.py` | - |
| Python SDK | DONE | `sdk/python`, `sdk/python/tests` | - |
| TypeScript SDK | IN PROGRESS | `sdk/typescript` | subagent |
| MCP server | IN PROGRESS | `mcp-server` | subagent |
| CLI | DONE | `backend/app/cli.py` (`mnemos --help`) | - |
| React dashboard (all screens) | IN PROGRESS | `web/` | subagent |
| Structured logs + redaction, health/ready, Prometheus metrics | DONE | `app/observability`, `/metrics`, worker `:8001` | - |
| Docker Compose dev + prod, Caddy TLS strategy | IN PROGRESS | `infra/` | subagent |
| VPS scripts: bootstrap/deploy/backup/restore/smoke, runbook | IN PROGRESS | `scripts/`, `docs/RUNBOOK.md` | subagent |

## Testing requirements (docs/06)
| Item | State | Evidence |
|---|---|---|
| Unit tests (state transitions, ranking, tokens, permissions, parsers, redaction, poisoning, policy) | DONE | `backend/tests/unit` |
| Integration (pgvector repos, migrations, transactions, concurrency, job idempotency) | DONE | `backend/tests/integration` |
| API tests (auth, validation, pagination, error contract, isolation) | DONE | integration suite via ASGI |
| Worker tests (extraction/validation/dream retry/idempotency with fake LLM) | DONE | `test_jobs_and_persistence.py`, dreaming tests |
| Frontend tests | IN PROGRESS | `web` vitest |
| Playwright E2E scenarios 1-10 on real stack | IN PROGRESS | `e2e/tests/*.spec.ts` written; needs prod stack run |
| Eval Run A -> learn -> Run B | DONE (dev stack) | `evals/`, `mnemos-eval`; re-run on prod stack pending |
| Deployment smoke | IN PROGRESS | `scripts/smoke-prod.sh` |

## Decisions
See `docs/adr/0001..0007`.

## Known limitations
- Postgres RLS not enabled (ADR 0003); isolation enforced in services and proven by tests.
- Token counts are chars/4 estimates (reported as estimates).

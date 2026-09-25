# Implementation Status - Requirements Traceability Matrix

Last updated: 2026-09-25 (final verification on commit `ed3510c` + docs/reports). All required items DONE with
evidence. Reports: `artifacts/implementation-report.md`, `artifacts/test-report.md`, `artifacts/deployment-report.md`.

## Environment notes (build sandbox)
- Docker daemon started manually (`dockerd`); Docker Hub rate-limited -> daemon uses `mirror.gcr.io` pull-through
  mirror (`/etc/docker/daemon.json`). Repo keeps canonical image names.
- Image builds behind the sandbox TLS proxy: `MNEMOS_BUILD_CA_FILE=/root/.ccr/ca-bundle.crt`.
- Integration tests use throwaway containers on 127.0.0.1:55432 / 56379 (`make test-db`).

## Product requirements
| Requirement (spec) | State | Evidence |
|---|---|---|
| FastAPI backend, `/v1` API baseline (00, 03) | DONE | `backend/app/api`, `docs/openapi.json` |
| Migrations, clean DB up/down/up, no drift (02, 06) | DONE | `tests/integration/test_migrations.py`; deploy `migrations applied: 0001` |
| PostgreSQL + pgvector (HNSW) + GIN FTS (02) | DONE | `app/db/models.py`, migration 0001 |
| Redis coordination (wake-ups, rate limit, locks, heartbeats) | DONE | `app/redis_client.py`, ADR 0002 |
| Durable idempotent jobs, retries, dead letter, lease recovery | DONE | `app/jobs/*`, `test_jobs_and_persistence.py`, E2E 10 |
| L0 immutable events / L1 TTL working memory / L2 episodes / L3 / L4 | DONE | ADR 0004, integration tests, promote endpoint |
| Experience ingestion, redaction, source trust | DONE | `experience_service.py`, redaction tests |
| Evidence/provenance + relation graph | DONE | `/evidence`, `/relations`, `/graph`, dashboard graph |
| Versioning + optimistic concurrency | DONE | E2E 6, `test_concurrent_patch_exactly_one_wins` |
| Extraction/validation/promote/merge/reject/dispute/review/supersede | DONE | `learning_service.py`, `domain/policy.py`, E2E 2/5/9 |
| Contradiction detection | DONE | `domain/contradiction.py`, E2E 5, contradiction dream test |
| Dreaming (6 modes, checkpoints, window idempotency, scheduler) | DONE | `dreaming_service.py`, `test_dreaming_lifecycle.py`, E2E 7, prod `dream_jobs` rows |
| Lifecycle/expiry/archival/forgetting | DONE | `lifecycle_service.py`, E2E 8 |
| Hybrid retrieval, rerank, token-budgeted context, traces | DONE | `retrieval_service.py`, ADR 0006, E2E 3 |
| Feedback + utility learning | DONE | `feedback_service.py`, E2E 4 |
| Multi-tenant auth/RBAC, audit, redaction, poisoning defenses | DONE | ADR 0003/0004, E2E 1/9 |
| Providers: fake, OpenAI-compatible, Ollama | DONE | `app/providers`, `tests/unit/test_providers.py` |
| Python SDK / TypeScript SDK / MCP server / CLI | DONE | `sdk/*`, `mcp-server`, `mnemos --help`; 8 + 43 + 46 tests; MCP auth verified via Caddy |
| Dashboard (11 screens) | DONE | `web/`, 71 tests, E2E dashboard spec |
| Structured logs, health/ready, metrics, optional OTel tracing | DONE | `app/observability`, smoke `api ready` |
| Docker Compose dev + prod, Caddy TLS strategy | DONE | `infra/`, ADR 0007, deployment report |
| VPS bootstrap/deploy/upgrade/rollback/backup/restore/smoke + runbook | DONE | `scripts/`, `docs/RUNBOOK.md`, deployment report |

## Acceptance gates (final clean-state run)
| # | Gate | State | Evidence |
|---|---|---|---|
| 1 | Fresh dependency setup | PASS | `make setup` in fresh clone |
| 2 | Format/lint/typecheck | PASS | `make lint`, `make typecheck` |
| 3 | Unit/integration/API/worker/frontend tests | PASS | `make test` (70+8+46+71+43), `make test-integration` (24) |
| 4 | E2E + eval | PASS | `make test-e2e`: 9/9 specs + eval PASS |
| 5 | Migrations on clean DB | PASS | migration roundtrip test, fresh deploy |
| 6 | Production images build | PASS | no-cache build in `make test-e2e` and `deploy.sh` |
| 7 | Production Compose boots, health checks pass | PASS | `deploy.sh` / `up --wait`, all services healthy |
| 8 | Ingest -> learn -> retrieve on production stack | PASS | smoke 12/12, CLI flow, eval on :80 |
| 9 | Tenant isolation/security tests | PASS | E2E 1/9, integration isolation/RBAC/poisoning, `make audit` clean |
| 10 | Backup + isolated restore verification | PASS | `make backup-test` VERIFIED |
| 11 | Documentation commands match reality | PASS | README/RUNBOOK commands executed; make targets/flags cross-checked |
| 12 | No required TODOs/stubs/skips | PASS | repo scan: none (only UI input placeholders) |

## Decisions
`docs/adr/0001..0007`, gap-filling specs `docs/09-detailed-specs.md`.

## Known limitations (documented, non-blocking)
- No Postgres RLS (service-layer isolation, tested). Token counts are chars/4 estimates.
- Operator inputs: real domain/ACME, ufw enablement, systemd timer, real LLM/embedding credentials.

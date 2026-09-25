# Test report

Final clean-state verification: fresh `git clone` of commit `ed3510c`, Docker build cache pruned, run on
2026-09-25 in the build sandbox (Ubuntu 24.04, Docker 29.3.1, Python 3.13.12, Node 22.22.2). Logs: `artifacts/logs/`.

| Gate | Command | Result |
|---|---|---|
| Fresh dependency setup | `make setup` | PASS (exit 0, 11 s) |
| Lint + format | `make lint` (ruff check, ruff format --check, eslint web + TS SDK, shellcheck) | PASS |
| Type checks | `make typecheck` (mypy 82 files, tsc web / TS SDK / e2e) | PASS |
| Unit tests | `make test` | PASS - backend unit 70, Python SDK 8, MCP 46, dashboard 71 (13 files), TS SDK 43 |
| Integration/API/worker | `make test-integration` (real Postgres 16 + pgvector 0.8.0 + Redis 7.4, throwaway containers) | PASS - 24 |
| Migrations on clean DB | `test_migrations.py`: upgrade -> downgrade -> upgrade + `alembic check` (no drift) | PASS |
| E2E (production stack) | `make test-e2e` -> images built without cache, `docker compose up --wait`, Playwright via Caddy edge | PASS - 9/9 specs |
| Eval (production stack) | same run, `mnemos-eval` | PASS (`artifacts/eval-report.md`) |

## Mandatory E2E scenarios (docs/06) - Playwright on the production Compose stack
| # | Scenario | Spec | Result |
|---|---|---|---|
| 1 | Two tenants, complete isolation (direct ID, search, vector, relations, evidence, traces, dreams, episodes, stats, graph, feedback) | `01-tenant-isolation.spec.ts` | PASS |
| 2 | Agent A experience -> extraction -> candidate -> validation -> active (history candidate/validated/active) | `02-learning-retrieval-feedback.spec.ts` | PASS |
| 3 | Agent B (other agent + session) receives the memory with evidence in token-budgeted context | same | PASS |
| 4 | Helpful feedback increments utility, content/version unchanged | same | PASS |
| 5 | Conflicting experience -> disputed + open conflict, no overwrite; resolution supersedes | `03-conflict-concurrency.spec.ts` | PASS |
| 6 | Concurrent PATCH same version -> exactly one 200, one 409 (current_version); no If-Match -> 428 | same | PASS |
| 7 | Dedup dream: 3 duplicates -> 1 canonical + 2 superseded, all experience evidence preserved | `04-dream-stale-poisoning.spec.ts` | PASS |
| 8 | Expired and superseded memories absent from context | same | PASS |
| 9 | Injection-like external experience never auto-promotes; agents cannot write org policy (403) | same | PASS |
| 10 | Stop worker, enqueue, `docker compose restart` whole stack: state persisted, queued job processed exactly once | `05-restart-persistence.spec.ts` | PASS |
| UI | Dashboard login, memory provenance/history, feedback, conflict resolution, dream run, graph, readiness | `06-dashboard.spec.ts` | PASS |

The same scenarios are also covered in-process by `backend/tests/integration` (plus worker crash/lease recovery,
retry/dead letter/manual retry, idempotency-key replay incl. 5 concurrent same-key writes, redaction, error
contract/limits, L0 immutability trigger, L1 TTL, all six dream modes, scheduler window idempotency, auto
conflict resolution, name-based read resolution).

## Learning eval (core value proposition)
Run A (agent-a, fresh session, no memory) hits a hidden environment rule, fails, diagnoses, fixes and records the
experience. The worker extracts/validates governed knowledge. Run B (agent-b, new session, analogous task)
requests context **before acting**. A control agent repeats Run B without memory. 5 task families; a known-false
memory (disputed by feedback) and a superseded memory are seeded and must never be served.

MEASURED (production-mode stack, `artifacts/eval-report.json`): Run B success 1.0; repeated-error rate 0.0 vs
control 1.0; relevant-memory recall 1.0; precision@k 1.0; false-memory rate 0.0; stale-memory use 0.0; tool calls
5 vs 22 (-77.3 %); context latency p50 22.65 ms / p95 30.12 ms; experience->active memory p50 366 ms / p95 390 ms.
A second run against the port-80 deployment gave the same rates (`artifacts/eval-report-prod.json`).

ESTIMATED (not measured): token counts are chars/4 estimates of a *simulated* agent transcript; the memory-enabled
run uses ~2x the estimated tokens of the control because the retrieved context is included while the simulated
diagnosis steps are short strings. No token or cost savings are claimed.

Limitation: the agent is a deterministic simulation and the LLM/embeddings are the deterministic fake providers;
with real providers the extraction wording and similarity scores change (real-provider tests are opt-in).

## Security validation
- Tenant isolation, RBAC and workspace-restricted keys: integration + E2E scenario 1.
- Poisoning: injection detector unit tests, validation policy unit tests, E2E scenario 9.
- Secret redaction before persistence and logging: unit + integration tests.
- Dependency audit (`make audit`): `pip-audit` on the locked, non-dev Python export -> "No known vulnerabilities
  found"; `npm audit` web and TS SDK -> 0 vulnerabilities. Postgres/Redis not reachable from the host
  and only Caddy publishes ports (smoke test checks).

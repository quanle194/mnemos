# Testing and Evaluation Specification

## Test pyramid
- Unit: domain state transitions, ranking math, token budgeting, permission rules, provider parsers.
- Integration: PostgreSQL/pgvector repositories, migrations, transactions, optimistic concurrency, job idempotency.
- API: auth, validation, pagination, error contracts, tenant isolation.
- Worker: extraction/validation/dream retry/idempotency using deterministic fake LLM providers.
- Frontend: component/critical flows.
- E2E: Playwright with `fullyParallel=false` where shared route/data conflicts could occur.
- Deployment smoke: clean Docker Compose boot, migrations, bootstrap, API/UI/MCP health.

## Deterministic testing
Create fake LLM and embedding providers. Core CI must not require paid external APIs. Real-provider tests are opt-in and tagged.

## Mandatory E2E scenarios
1. Create two tenants; prove complete isolation.
2. Agent A records successful experience -> extraction -> candidate -> validation -> active memory.
3. Agent B requests context and receives the memory with evidence.
4. Feedback helpful increments utility signal.
5. Conflicting experience creates conflict/disputed/superseding path rather than silent overwrite.
6. Concurrent PATCH with same version: exactly one succeeds, other gets 409.
7. Dream deduplicates repeated experiences/memories while preserving provenance.
8. Expired/superseded memory is absent from normal context.
9. Injection-like external experience cannot auto-promote into privileged policy.
10. Restart containers/workers and prove persisted state/jobs remain consistent.

## Benchmark/evals
Create fixtures where a baseline agent repeats a known failure and a memory-enabled agent receives the learned rule. Measure task success, repeated-error rate, relevant-memory recall, false-memory rate, stale-memory use, tool-call/token estimates and latency. Do not claim actual token/cost savings unless measured; record estimates separately.

## Release gates
All lint/typecheck/unit/integration/E2E tests pass; migration up/down or forward migration strategy tested; no high-severity dependency/security findings accepted silently; Docker images build; fresh VPS-like Compose deployment smoke passes; README runbook works from clean clone.

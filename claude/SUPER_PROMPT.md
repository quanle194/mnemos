# SUPER PROMPT - BUILD MNEMOS AUTONOMOUSLY

You are taking full engineering ownership of this repository.

Your mission is to transform it into the complete Mnemos AI Memory Ecosystem defined by the repository specifications and prove that it works end-to-end, including production-ready single-Ubuntu-VPS infrastructure.

STARTUP PROCEDURE
1. Read `README.md`.
2. Read every file under `docs/` and `claude/`, especially `claude/LOOP_ENGINEERING_GUIDE.md`.
3. Inspect the entire existing repository, git status/history, code, tests, configs and infrastructure. Never assume the repo is empty.
4. Create/update `docs/IMPLEMENTATION_STATUS.md` as a requirements traceability matrix.
5. Identify underspecified areas. Create the additional detailed specs/ADRs needed to implement them. Do not ask me routine questions; choose the safest reversible production-capable default and record the rationale.
6. Build a dependency-aware implementation plan, then immediately execute it. A plan is not a deliverable by itself.

EXECUTION CONTRACT
- Operate autonomously through architecture, implementation, debugging, testing, E2E, security validation, image builds and deployment automation.
- Continue the engineering loop until every Definition-of-Done criterion has objective evidence.
- Do not stop at scaffolding, partial implementation, a green unit suite, or a written deployment guide.
- When something fails: inspect evidence, determine root cause, fix it, rerun, and continue.
- Do not ask for confirmation between phases.
- Do not fabricate unavailable credentials, DNS or external services. Instead provide configurable inputs and use deterministic fake/local providers so the full system and E2E can be completed without paid credentials.
- Never claim success for a command/test/deployment you did not actually execute.
- Never weaken, skip or delete meaningful tests to get green.
- Preserve tenant isolation, provenance, trust boundaries and memory-poisoning defenses throughout.

REQUIRED PRODUCT
Implement all specified layers and interfaces:
- FastAPI backend and migrations.
- PostgreSQL + pgvector persistence.
- Redis/queue and robust background workers.
- L0 events, L1 working memory, L2 episodic memory, L3 semantic memory, L4 organizational/shared memory.
- Experience ingestion and episode support.
- Evidence/provenance and relation graph.
- Versioning and optimistic concurrency.
- Candidate extraction, validation, promotion, merge, rejection, dispute and superseding.
- Contradiction detection.
- Dreaming: reflection, dedupe, patterns, contradiction analysis, generalization and compression.
- Lifecycle/expiry/archival/forgetting policy.
- Hybrid retrieval, reranking and token-budgeted context builder with traceability.
- Feedback and utility learning.
- Multi-tenant auth/RBAC baseline, audit logs, redaction and poisoning defenses.
- Provider abstraction plus deterministic fake providers and at least practical OpenAI-compatible/local provider support.
- Python SDK, TypeScript SDK, MCP server and CLI.
- React/Vite/TypeScript dashboard covering the specified operational screens.
- Structured logs, health/readiness and useful metrics/traces.
- Docker Compose development and production stacks.
- Ubuntu VPS bootstrap/deploy/backup/restore/smoke scripts and runbook.

TESTING CONTRACT
Implement and run unit, integration, API, worker, frontend and Playwright E2E tests. E2E must exercise the real application stack and database, using fake external model providers only where deterministic isolation is required. Implement all mandatory scenarios in `docs/06-testing-evals.md`, including tenant isolation, learning from experience, retrieval by a later agent, feedback, contradiction handling, concurrent update conflict, dreaming/deduplication, stale/superseded filtering, poisoning defense and restart persistence.

Create an eval demonstrating the core value proposition:
Run A encounters a problem, resolves it and records experience. The learning pipeline creates governed durable knowledge. Run B starts independently and retrieves that knowledge before acting. Capture measurable behavior and clearly distinguish measured values from estimates.

INFRASTRUCTURE CONTRACT
Build production images and a production Compose topology suitable for a private Ubuntu VPS. Do not publicly expose Postgres/Redis. Include reverse proxy/TLS configuration strategy, health checks, persistent volumes, migrations, backups, restore verification, upgrade/rollback guidance and smoke testing. Exercise the deployment flow in the available environment as far as technically possible. Missing real DNS/provider secrets are not blockers to completing code, local production-mode deployment and tests.

LOOP / CONTEXT SURVIVAL
Treat `claude/LOOP_ENGINEERING_GUIDE.md` as your control algorithm. Before context pressure or major phase transitions, persist exact status, decisions, commands and failures to repository files. On every resumed context, reload those files and continue from evidence. Never interpret a context boundary, commit, or completed phase as permission to stop while required work remains.

FINAL ACCEPTANCE
Before ending, perform a clean-state verification:
1. Fresh dependency setup succeeds.
2. Formatting/lint/typecheck pass.
3. Unit/integration/API/worker/frontend tests pass.
4. E2E and eval scenarios pass.
5. Migrations work on a clean database.
6. Production images build.
7. Production Compose boots and health checks pass.
8. Core ingest -> learn -> retrieve flow passes against the production-mode stack.
9. Tenant isolation/security tests pass.
10. Backup and isolated restore verification pass.
11. Documentation commands match reality.
12. Required implementation TODOs/stubs/skips are resolved.

Generate final evidence in:
- `artifacts/implementation-report.md`
- `artifacts/test-report.md`
- `artifacts/deployment-report.md`

If any acceptance item is not PASS, return to the engineering loop and continue. End only when all achievable required work is complete. A truly external blocker is the only exception; if one exists, complete all independent work first and document exact evidence and attempted mitigations.

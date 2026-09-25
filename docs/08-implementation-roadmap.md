# Autonomous Implementation Roadmap

## Phase 0 - Reconnaissance and detailed specs
Read all repository docs. Inspect existing code before changing anything. Produce/update ADRs, task graph and any missing detailed specs. Do not ask questions when a safe reversible engineering default exists; record assumptions.

## Phase 1 - Foundation
Monorepo, formatting/lint/typecheck, FastAPI, React app, PostgreSQL/pgvector, Redis, migrations, settings, health, auth/API-key bootstrap, CI, Docker Compose.

## Phase 2 - Memory core
Tenancy, events, experiences, memories, evidence, relations, versions, semantic/lexical search, context builder, feedback, audit traces. Build SDKs.

## Phase 3 - Learning pipeline
Fake providers first, then provider interfaces/adapters. Extraction, candidate status, validation, duplicate/contradiction handling, promotion and job idempotency.

## Phase 4 - Dreaming/lifecycle
Dream jobs, reflection/dedupe/pattern/contradiction/generalization/compression, scheduling, lifecycle/decay, superseding.

## Phase 5 - Interfaces
MCP server, CLI, dashboard flows, API docs/examples.

## Phase 6 - Quality
Complete unit/integration/API/E2E/evals, security isolation, injection tests, concurrency tests, failure/retry tests, load sanity checks.

## Phase 7 - Production infrastructure
Production Compose, reverse proxy, scripts, backups/restore, deployment smoke, Ubuntu runbook.

## Phase 8 - Closure
Run every quality gate from clean state, remove dead code/TODOs that represent required work, verify docs against commands, generate implementation/test/deployment reports and final handoff.

## Completion definition
Do not call the project complete because code was generated. Complete means: required features implemented; migrations work; deterministic tests pass; E2E passes; images build; production Compose starts; smoke scenario passes; security isolation tests pass; docs/runbooks are executable; remaining items are only explicitly documented external inputs (e.g. real domain/provider secret) or future non-goals.

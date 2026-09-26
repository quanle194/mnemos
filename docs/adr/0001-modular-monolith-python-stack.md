# ADR 0001 - Modular monolith on Python 3.13 / FastAPI / SQLAlchemy async

Status: accepted

## Context
`docs/01-architecture.md` recommends a modular monolith with explicit workers, Python 3.13,
FastAPI, Pydantic v2, SQLAlchemy 2 async, Alembic, PostgreSQL 16 + pgvector.

## Decision
- One Python package `app` (in `backend/`) containing API, worker, scheduler and CLI entry points.
- Modules live under `app/modules/<name>/` and expose services; request handlers (`app/api/`) only call
  services and always pass an explicit `TenantContext`. Services never read tables of an unrelated tenant.
- A single container image runs `api`, `worker` or `migrate` depending on command.
- Package management via `uv` workspace (`backend`, `sdk/python`, `mcp-server`, `evals`).

## Consequences
Single deployable, simple transactions across modules; modules can be split later because the service
contracts are typed and tenant-scoped.

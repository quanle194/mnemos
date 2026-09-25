# Architecture

## Style
Use a modular monolith for synchronous APIs and explicit background workers for expensive/asynchronous processing. Enforce package boundaries so modules can later split without redesigning contracts.

## Runtime topology
Agents -> REST/SDK/MCP -> API -> modules -> PostgreSQL/pgvector. Workers consume queued jobs for extraction, validation, embeddings, dreaming and lifecycle maintenance. Redis may provide cache, distributed locks and queue broker depending on selected job library.

## Backend modules
- identity/tenancy
- events
- working_memory
- experiences/episodes
- memories
- evidence/provenance
- relations/versioning
- retrieval/context
- feedback/utility
- learning/extraction
- validation/conflicts
- dreaming/consolidation
- providers
- jobs
- audit/observability

No module may bypass tenancy authorization by directly querying another module's tables from request handlers.

## Recommended stack
Python 3.13, FastAPI, Pydantic v2, SQLAlchemy 2 async, Alembic, PostgreSQL 16+ with pgvector, Redis, Dramatiq or Celery (choose one and document ADR), pytest. Frontend: React + Vite + TypeScript, TailwindCSS, shadcn/ui, TanStack Query, React Router, React Hook Form + Zod, Sonner, Playwright. Docker Compose for local/prod single-VPS deployment.

## Provider ports
Define `LLMProvider` and `EmbeddingProvider` interfaces. Required implementations: OpenAI-compatible HTTP and Ollama/local-compatible path; other providers can be adapters. Structured generation must validate schemas and retry safely. Provider failures must not corrupt state.

## Consistency
- Database transactions protect promotion/version/relation changes.
- Optimistic concurrency via integer version/ETag for memory mutation.
- Jobs are idempotent and carry stable idempotency keys.
- At-least-once execution must be safe.
- Outbox pattern is preferred when DB state and job publication must be atomic.

## Dashboard
Overview, Memories, Experiences, Dreams, Conflicts, Knowledge Graph/relations, Agents, Workspaces, Evals, Settings. Memory detail must expose type/status/scope/confidence/trust/importance/utility/evidence/history/relations/retrieval usage.

## Engineering constraints
Keep domain logic independent of FastAPI/ORM where practical. Use typed service contracts. No hidden global provider state. All important state transitions emit audit events. Configuration via environment with validated settings.

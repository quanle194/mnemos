# ADR 0002 - PostgreSQL-backed durable job queue (transactional outbox) with Redis wake-ups

Status: accepted

## Context
The architecture doc suggests Dramatiq or Celery and says an outbox is preferred when DB state and job
publication must be atomic. Mandatory E2E scenario 10 requires jobs to survive container restarts, and all
jobs must be idempotent with at-least-once execution.

## Decision
The `jobs` table *is* the outbox and the queue:
- Jobs are inserted in the same transaction as the state that requires them (e.g. experience insert +
  `extract_experience` job) - no dual-write window.
- Every job carries a unique `idempotency_key`; enqueueing the same key twice is a no-op (`ON CONFLICT DO NOTHING`).
- Workers lease jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, set `locked_until`; expired leases are re-claimed
  (crash recovery). Failures retry with exponential backoff; after `max_attempts` a job is `dead` (dead letter),
  visible in metrics and dashboard.
- Handlers are idempotent (they check prior processing markers before mutating).
- Redis is used for: worker wake-up notifications (`LPUSH`/`BRPOP`, polling fallback when Redis is down),
  API rate limiting, scheduler leader lock, and worker heartbeats/queue-depth reporting.

Dramatiq/Celery were rejected for V1 because they store the queue in Redis/RabbitMQ, which re-introduces
the dual-write problem and makes restart consistency depend on broker persistence settings.

## Consequences
Simple ops (Postgres is already the system of record, backed up together with jobs). Throughput is bounded by
Postgres (thousands of jobs/min are fine for single-VPS scale). Switching to a broker later only requires a
new dispatcher reading the outbox.

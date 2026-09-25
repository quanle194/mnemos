# Security, Tenancy and Observability

## Tenant isolation
Every request resolves authenticated principal -> allowed organization/workspace/project scopes. Repository/service methods require tenant context. Tests must prove cross-tenant IDs cannot be retrieved through direct ID, search, vector search, relations, evidence, traces or dream jobs.

## Secrets/privacy
Never store provider secrets in DB plaintext. Environment/secret manager for V1. Redact common secrets from events/experiences before persistence (API keys, bearer tokens, passwords, private keys) with configurable hooks. Log redaction must run before structured logs are emitted.

## RBAC baseline
Roles: admin, maintainer, agent, viewer. Separate permissions for read memory, write experience, propose memory, review/promote, run dreams, manage workspace/API keys.

## Abuse/poisoning
Rate limits; input size limits; prompt injection classifier/rules for candidate promotion; provenance; trust boundaries; privileged policy-memory protection; audit all promotions/merges/supersedes.

## Observability
Structured JSON logs with request/job IDs. Metrics: request latency/errors, retrieval latency, candidate count, selected count, context tokens, extraction rate, promotion/rejection/conflict rates, dream duration/compression ratio, feedback distribution, stale-memory use, job retries/dead letters. OpenTelemetry-compatible tracing is preferred.

## Retrieval trace
Store candidate IDs, component scores, filters/reasons, final selections and token count. Avoid storing raw secrets in traces. This trace is the basis for debugging and evals.

## Health
`/health/live`, `/health/ready`; readiness verifies DB and required dependencies. Worker health/queue depth exposed for operations.

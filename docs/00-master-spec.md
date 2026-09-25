# Mnemos Master Specification

## Mission
Build a model-agnostic memory platform for AI agents. Agents emit events and experiences; Mnemos turns evidence into governed knowledge, retrieves useful context, learns from outcomes, and continuously improves memory without retraining model weights.

## Problems and mechanisms
1. Session amnesia -> persistent memory.
2. No learning from experience -> experience store and extraction.
3. Unbounded memory -> consolidation, compression, lifecycle and forgetting.
4. Concurrent writers -> versioning, optimistic concurrency and controlled mutation.
5. Stale knowledge -> temporal validity, superseding and archival.
6. Memory poisoning -> provenance, trust, validation and promotion gates.
7. Fragmented knowledge -> asynchronous dreaming/reflection across trajectories.

## Core principles
- Conversation history is not memory.
- Vector search is one retrieval primitive, not the memory system.
- Worker agents write evidence/experiences and propose memories; trusted memory is governed.
- Every promoted memory must be explainable through provenance/evidence.
- Preserve history; supersede rather than silently overwrite.
- Retrieval is scope-aware, hybrid, ranked and token-budgeted.
- Model and embedding providers are replaceable.
- Start as a modular monolith plus workers; scale components only when measurements require it.

## Memory hierarchy
- L0 Raw Events: immutable user/assistant/tool/error/feedback/task events.
- L1 Working Memory: temporary task/session state with TTL.
- L2 Episodic Memory: summarized task trajectories and outcomes.
- L3 Semantic Memory: facts, procedures, rules, constraints, decisions, lessons, patterns and warnings.
- L4 Organizational Memory: trusted shared knowledge scoped to organization/workspace/project.

## Scope hierarchy
`global -> organization -> workspace -> project -> agent -> session`.
Retrieval must never cross an unauthorized tenant/scope boundary.

## Memory lifecycle
`candidate -> validated -> active -> disputed/superseded -> archived`, with `rejected` as terminal candidate outcome. Physical deletion is reserved for explicit retention/privacy requirements.

## Required components
- FastAPI API application.
- Background worker.
- PostgreSQL + pgvector.
- Redis for cache/queue coordination where useful.
- React/Vite/TypeScript dashboard.
- Python SDK.
- TypeScript SDK.
- MCP server.
- CLI.
- Provider abstraction for LLM and embeddings.
- Experience extractor, validator, contradiction detector, consolidation engine, dreaming scheduler/worker, retrieval/reranker/context builder, feedback/utility engine, lifecycle/forgetting engine.

## Primary integration flow
1. Agent requests context with workspace/project/agent/query/token budget.
2. Mnemos retrieves authorized active memories, filters superseded/expired entries, hybrid-ranks and builds bounded context.
3. Agent executes task.
4. Agent records experience and optionally per-memory feedback.
5. Workers extract candidate memories with evidence.
6. Validation compares against existing knowledge and chooses promote/merge/reject/dispute/review.
7. Dreaming periodically finds patterns, duplicates, conflicts and generalizations and proposes consolidated knowledge.
8. Future agents retrieve improved knowledge.

## Memory types
`fact, preference, procedure, rule, constraint, decision, lesson, pattern, warning, failure, success, relationship, context`.

## Trust dimensions
Keep separate fields for confidence, source trust, importance and observed utility. Do not collapse them into a single opaque score. Promotion/ranking formulas must be configurable and traceable.

## Evidence
Every candidate/promoted semantic memory stores links to evidence. Source types include event, episode, experience, user_statement, document, tool_result and memory. The system must answer: "Why does Mnemos believe this?"

## Relations
Support `supports, contradicts, supersedes, derived_from, related_to, generalizes, specializes`.

## Retrieval
Use hybrid candidate generation: semantic similarity + lexical search + scope + memory type + temporal validity. Ranking considers relevance, importance, trust, recency and utility. Context builder deduplicates, excludes superseded knowledge, honors token budget and returns selected memory IDs/scores/reasons.

## Feedback
Feedback values: `helpful, irrelevant, incorrect, outdated, harmful`. Feedback affects utility/trust/lifecycle but must not rewrite memory directly.

## Dreaming
Asynchronous only; never required on request critical path. Modes: reflection, deduplication, pattern discovery, contradiction analysis, generalization, compression. Triggers: schedule, event count, memory growth, manual request. All changes remain auditable proposals before trusted promotion according to policy.

## API baseline
- POST `/v1/events`
- POST/GET `/v1/experiences`
- POST/GET/PATCH/DELETE `/v1/memories`
- POST `/v1/memories/search`
- POST `/v1/context`
- POST `/v1/memories/{id}/feedback`
- GET `/v1/memories/{id}/history`
- GET `/v1/memories/{id}/evidence`
- GET `/v1/memories/{id}/relations`
- POST `/v1/dreams`
- GET `/v1/dreams/{id}`

## V1 proof
Run A discovers a durable project rule from a failure and successful resolution. It is stored as evidence -> candidate -> validated active memory. Run B, using a different agent/session, retrieves it before acting and completes the analogous task with fewer errors/tool calls/tokens. Dashboard exposes provenance, version/history, retrieval use and feedback.

## Non-goals for initial release
- Training/fine-tuning model weights.
- Kafka/NATS, multi-region, Kubernetes or dedicated graph/vector DB without measured need.
- Letting arbitrary agents directly mutate trusted organizational policy.

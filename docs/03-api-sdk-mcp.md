# API, SDK and MCP Contracts

## API conventions
JSON, `/v1`, request IDs, structured errors, pagination, idempotency keys for writes, OpenAPI generated from FastAPI. Auth via API key in V1 with workspace scopes; design interface for later OIDC/RBAC.

## Context request
`POST /v1/context`
Input: workspace_id, optional project_id/agent_id/session_id, query, token_budget, optional memory_types, max_items.
Output: rendered context, selected memories with IDs/type/content/score/reasons/evidence summary, token estimate, retrieval_trace_id.

## Experience request
`POST /v1/experiences`
Input: workspace/project/agent/session/task identifiers, task, observation, action, result, outcome, importance, confidence, metadata. Return stable ID and learning-job status/reference.

## Memory mutation
PATCH requires expected version through `If-Match` or explicit expected_version. Mismatch -> HTTP 409 with current version. Normal agents cannot promote to trusted organizational policy unless permission/policy allows it.

## Search
Supports query, scopes, types, statuses, temporal filters, limit. Return score breakdown, not only total score.

## SDK ergonomics
Python and TS clients expose: `context`, `experience`, `search_memories`, `get_memory`, `feedback`, `dream`. Include retries for transient network errors but never retry unsafe writes without idempotency key.

Example desired TS usage:
```ts
const context = await client.context({workspaceId, query, tokenBudget: 3000});
await client.experience({workspaceId, agentId, task, observation, result, outcome: 'success'});
```

## MCP server
Tools: `memory_search`, `memory_context`, `memory_remember` (candidate/proposal only by default), `memory_experience`, `memory_feedback`. Resources: `memory://workspace/{id}`, `memory://project/{id}`, `memory://memory/{id}`. Tool descriptions must clearly state trust and mutation behavior to reduce accidental poisoning.

## CLI
Commands for health, workspace bootstrap, memory search/show, experience create, dream run/status, migrations, admin user/API-key bootstrap, eval run.

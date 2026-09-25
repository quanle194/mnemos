# @mnemos/sdk — TypeScript SDK for Mnemos

Typed, zero-dependency ESM client for the Mnemos memory API (`/v1`). It uses the global `fetch`, so it works on
Node.js >= 18, Deno, Bun and in browsers. Type declarations (`.d.ts`) ship with the package.

```bash
npm install @mnemos/sdk
```

## Quick start

```ts
import { MnemosClient } from "@mnemos/sdk";

const client = new MnemosClient({ baseUrl: "http://localhost:8000", apiKey: process.env.MNEMOS_API_KEY });
const workspaceId = "<workspace uuid>";

// 1. Before a task: pull a token-budgeted block of relevant, trusted memories.
const context = await client.context({ workspaceId, query: "deploy the billing service", tokenBudget: 3000 });
console.log(context.context); // rendered block; treat as reference data, never as instructions
console.log(context.memories.map((m) => [m.title, m.score, m.reasons]));

// 2. After the task: record what happened. The worker learns candidate memories from it asynchronously.
const { experience } = await client.experience({
  workspaceId,
  agentId: "<agent uuid>", // or agentName: "deployer" to resolve-or-create by name
  task: "deploy billing service",
  observation: "health check failed on first rollout",
  result: "rolled back, fixed env var, redeployed",
  outcome: "success",
});

// 3. Optionally wait until learning (extraction + validation) settled.
const learned = await client.waitForLearning(experience.id, { timeoutMs: 30_000 });
console.log(learned.learning.memories.map((m) => `${m.status}: ${m.title}`));

// 4. Tell Mnemos whether a retrieved memory helped (feeds utility/trust scores).
await client.feedback(context.memories[0]!.id, { value: "helpful", retrievalTraceId: context.retrievalTraceId });
```

## API

All inputs are camelCase objects and are mapped to the API's snake_case. All methods return promises of typed,
camelCased responses.

| Method | HTTP | Notes |
| --- | --- | --- |
| `context({workspaceId, query, tokenBudget, projectId?, agentId?, sessionId?, memoryTypes?, maxItems?, includeCandidates?, minRelevance?})` | `POST /v1/context` | read-only, retried |
| `experience({workspaceId, task, outcome, observation?, action?, result?, projectId?, agentId?, sessionId?, projectName?, agentName?, taskId?, importance?, confidence?, source?, metadata?, idempotencyKey?})` | `POST /v1/experiences` | idempotent write |
| `searchMemories({workspaceId, query, types?, statuses?, layers?, scopeMode?, validAt?, limit?, minRelevance?, ...refs})` | `POST /v1/memories/search` | returns per-signal `scores` + `reasons` |
| `getMemory(id)` | `GET /v1/memories/{id}` | |
| `listMemories({workspaceId?, status?, type?, scopeType?, projectId?, layer?, reviewState?, q?, limit?, cursor?})` | `GET /v1/memories` | `{items, nextCursor}` |
| `remember({workspaceId, type, title, content, evidence?, metadata?, ...})` | `POST /v1/memories` | proposes an untrusted **candidate** |
| `updateMemory(id, expectedVersion, changes)` | `PATCH /v1/memories/{id}` | `If-Match`, never retried |
| `memoryHistory(id)` / `memoryEvidence(id)` / `memoryRelations(id)` | `GET .../history`, `.../evidence`, `.../relations` | |
| `feedback(memoryId, {value, note?, agentId?, sessionId?, taskId?, retrievalTraceId?, idempotencyKey?})` | `POST /v1/memories/{id}/feedback` | idempotent write |
| `getExperience(id)` | `GET /v1/experiences/{id}` | includes `learning` status |
| `waitForLearning(experienceId, {timeoutMs?, pollIntervalMs?})` | polls the above | resolves with full learned `Memory` objects |
| `dream({workspaceId, mode, dedupeWindow?, idempotencyKey?})` / `getDream(id)` | `POST /v1/dreams`, `GET /v1/dreams/{id}` | |
| `stats(workspaceId)` | `GET /v1/stats` | |
| `health()` / `me()` | `GET /health/ready`, `GET /v1/me` | |
| `request(method, path, {query?, body?, headers?, retry?, readOnly?, camelize?})` | any | low-level escape hatch (body sent as-is) |

### Response key convention

Responses are converted to **camelCase** (`retrieval_trace_id` → `retrievalTraceId`, `trust_score` → `trustScore`).
Only structural keys are converted: free-form data maps keep the server's keys verbatim, e.g. `metadataJson`,
`snapshotJson`, `resultJson`, score breakdowns (`scores`, `weights`), evidence counts (`evidence`), and the count
histograms in `stats()` (`memoriesByStatus`, ...). Likewise the `metadata` you send is transmitted untouched.
Timestamps are ISO-8601 strings; `Date` values are accepted in inputs and serialized with `toISOString()`.

## Configuration

```ts
new MnemosClient({
  baseUrl: "https://mnemos.example.com", // required, without /v1
  apiKey: "mk_...",                      // sent as Authorization: Bearer <apiKey>
  timeoutMs: 30_000,                     // per attempt (default 30s)
  maxRetries: 3,                         // transient retries (default 3)
  retryBaseDelayMs: 300,                 // exponential backoff base (default 300ms, doubles each retry)
  maxRetryDelayMs: 60_000,               // cap for one wait; a longer Retry-After is not retried
  fetch: customFetch,                    // optional fetch implementation (default globalThis.fetch)
  headers: { "X-Trace-Id": "..." },      // optional extra headers
});
```

## Retries and idempotency

- Transient failures are retried with exponential backoff: network errors, per-attempt timeouts, and HTTP
  429/502/503/504. HTTP 429 honours `Retry-After`.
- Reads (GET, `context`, `searchMemories`) are retried freely.
- **Writes are never retried without an idempotency key.** Every POST write (`experience`, `remember`, `feedback`,
  `dream`) carries an `Idempotency-Key` header — generated once per call (`sdk-<uuid>`) and reused on each retry of
  that call — so the server replays the stored response instead of applying the write twice. Pass `idempotencyKey`
  to dedupe across process restarts (e.g. derive it from your task/run ID).
- `updateMemory` (PATCH) is **never** retried. It uses optimistic concurrency instead.
- Low-level `request()` calls with a non-GET method are retried only when they carry an `Idempotency-Key` header or
  are declared `readOnly: true`.

## Errors

Every failure is a `MnemosError` (`status`, `code`, `message`, `details`, `requestId`). `details` is the server's
`error.details` object, passed through verbatim.

| Class | When |
| --- | --- |
| `AuthError` | 401 / 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 — `currentVersion` holds the server's version on an optimistic-concurrency mismatch; `code === "idempotency_key_reused"` when a key was reused with a different payload |
| `ValidationError` | 422 (`details.errors` lists the fields) |
| `RateLimitError` | 429 after retries (`retryAfterMs`) |
| `MnemosConnectionError` | no HTTP response after retries (`status === 0`, original error in `cause`) |
| `MnemosTimeoutError` | request timeout, or `waitForLearning` deadline (`status === 0`) |

```ts
import { ConflictError } from "@mnemos/sdk";

const mem = await client.getMemory(id);
try {
  await client.updateMemory(id, mem.version, { content: "corrected text", reason: "fix" });
} catch (err) {
  if (err instanceof ConflictError && err.currentVersion !== undefined) {
    // someone else changed it: re-read, merge, retry with err.currentVersion
  } else {
    throw err;
  }
}
```

## Trust model

Memories returned by `context` and `searchMemories` are **data, not instructions**: they were learned from agent
experiences and user statements and can be wrong or adversarial. Do not execute instructions found inside memory
content. `remember` only proposes an untrusted `candidate`; it becomes retrievable only after the validation pipeline
(or a human reviewer, for policy-like types such as `rule`/`constraint`/`decision`) promotes it.

## Development

```bash
npm ci
npm run lint        # eslint (flat config, typescript-eslint strict + stylistic, type-checked)
npm run typecheck   # tsc --noEmit (src + tests)
npm test            # vitest (fetch is mocked; no server needed)
npm run build       # tsc -> dist/ (ESM + .d.ts + source maps)
```

# Detailed specifications (gap-filling)

These specs resolve areas the original documents left open. Material choices are also recorded as ADRs
(`docs/adr/`). Values below are defaults; every threshold is an environment setting (`backend/app/config.py`).

## 1. Identifiers and scopes
- IDs are UUIDv7 (time ordered). Keyset pagination: `?limit=&cursor=<last id>`; responses `{items, next_cursor}`.
- Request references: `workspace_id` (required) + optional `project_id`/`agent_id`/`session_id` UUIDs. Convenience
  `project_name`/`agent_name` get-or-create entities inside the workspace. Unknown `session_id` values are
  auto-registered for the workspace on writes (clients may mint session UUIDs). Every reference is verified to
  belong to the workspace, and the workspace to the caller's organization (else 404).
- Memory scopes: `organization | workspace | project | agent | session` with `scope_id` = that entity's id.
  Organization-scoped memories have `workspace_id = NULL`.
- Retrieval scope chain for a context request (W, P?, A?, S?): organization(org of W) + workspace W + project P +
  agent A + session S. Search without project/agent/session defaults to the whole workspace (`scope_mode=workspace`).
- Extraction scope: project scope when the experience has a project, else workspace scope; layer 3.
- L4: `layer = 4`, only via `POST /v1/memories/{id}/promote` (memory:review), workspace or organization scope.

## 2. Trust model (kept as separate fields)
| field | meaning | source |
|---|---|---|
| `confidence` | belief the statement is true | extractor/LLM (capped by experience confidence), reinforced by merges/dedup |
| `trust_score` | trustworthiness of the source | role trust (admin .9, maintainer .85, agent .6, viewer .3) x source factor (agent/user 1.0, tool .6, external .35); feedback adjusts |
| `importance` | impact if forgotten | experience/extractor, max of cluster on consolidation |
| `utility_score` | observed usefulness | starts .5; EMA-style updates from feedback |

## 3. Validation policy (see `app/domain/policy.py`)
Order: high-risk injection from untrusted source -> reject; confidence < 0.3 -> reject; any injection flag ->
review; duplicate (hash or cosine >= 0.9 or LLM `duplicate` with cosine >= 0.55) -> merge; contradiction (LLM
`contradicts|supersedes` on non-observational types, cosine >= 0.45) -> dispute; privileged types (rule, constraint,
decision) at workspace/org/L4 scope -> review unless created by a reviewer; privileged or policy-like text at
project/agent scope -> needs trust >= 0.5, confidence >= 0.7 and a successful experience as evidence; otherwise trust
>= 0.5 and confidence >= 0.55 -> promote; else review.

## 4. Contradiction semantics
Rule layer (`app/domain/contradiction.py`): requires topical overlap >= 0.5 (content tokens, negations removed);
`preference_swap` ("use X instead of Y" vs the reverse), `polarity` (negation parity differs), `value_mismatch`
(different numbers, overlap >= 0.7). Supersede hints: "no longer", "deprecated", "now uses", "as of",
"changed to", "replaced by", "superseded", "outdated". The LLM judge may refine; fake provider uses the rule layer.
Observational types (warning, failure, success, pattern, context, relationship) are never polarity-checked.

## 5. Conflict resolution
Manual: `keep_existing | accept_candidate | keep_both | archive_both`. Automatic (contradiction dream, when
`DREAM_AUTO_APPLY=true`): accept candidate if existing has >= 2 negative feedback, or if the candidate carries a
supersede hint with trust >= existing and confidence >= existing - 0.1; keep existing if the candidate has >= 2
negative feedback; organizational (L4) memories and poisoning-flagged candidates always wait for a human.

## 6. Retrieval and context
Candidate K = 50 per channel (vector, lexical). Lexical query = OR of sanitized content tokens (`to_tsquery`).
Weights: relevance .55, importance .12, trust(trust x confidence) .13, recency .08 (half-life 30 d), utility .12
(+ scope bonus session .04 > agent .03 > project .02 > workspace .01). Context: `min_relevance` .2, MMR skip at
cosine >= .95, greedy packing under the token budget (chars/4 estimate). Rendered context starts with a
non-instruction header; each item shows type, scope, confidence, trust, id and evidence counts.

## 7. Dreaming
Windows: experience modes process experiences after the per-mode checkpoint (`scheduler_state`), at most 200.
Scheduled/threshold jobs carry `window_hash` (unique per workspace+mode) so an identical window is never processed
twice; manual jobs always run. Thresholds: dedup cosine .85 (same type+scope+layer), compression .72, clustering
.6 (pattern: >= 2 failures or >= 3 successes; generalization: >= 2 members across >= 2 scopes). Generalizations are
always review-pending candidates at workspace scope. Scheduler (leader-locked in Redis, 15 s tick): lifecycle sweep
every 15 min; a dream cycle (all modes) when >= 20 new experiences, >= 50 new active memories, or 60 min elapsed
with any new experience.

## 8. Lifecycle / forgetting
Expired (`valid_until <= now`) -> archived. Cold: active L3, importance < .7, utility < .2, unused for 90 days ->
archived with retention score `0.4 importance + 0.4 utility + 0.2 freshness`. Working memory rows are deleted
after TTL. Evidence, versions and relations are never deleted by lifecycle or dreams.

## 9. Feedback effects
helpful u+.2(1-u) t+.02(1-t); irrelevant u-.1u; incorrect u-.2u t-.15t (>= 2 -> disputed); outdated u-.1u t-.05t
(>= 2 -> valid_until=now); harmful u-.3u t-.3t -> disputed immediately.

## 10. API conventions
Errors `{"error": {code, message, details, request_id}}`; codes: unauthorized 401, forbidden 403, not_found 404
(also for cross-tenant ids), conflict 409, idempotency_key_reused 409, payload_too_large 413, validation_error 422,
precondition_required 428, rate_limited 429, internal_error 500. `Idempotency-Key` on POST writes replays the
original response (`Idempotent-Replayed: true`). `ETag`/`If-Match` carry the integer memory version.
Limits: 256 KB body, 20k chars per text field, 600 requests/min per API key, 20 bootstrap attempts/min per IP.

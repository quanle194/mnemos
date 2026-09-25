# ADR 0006 - Hybrid retrieval, ranking and token budgeting

Status: accepted

## Decision
Candidate generation = union of (a) pgvector cosine top-K and (b) Postgres full-text (`websearch_to_tsquery`,
`ts_rank_cd`) top-K, both constrained by tenant, authorised scope chain, status, type and temporal validity.
Exact vector search is used (small V1 datasets); an HNSW index is created and used automatically by the planner
once volume justifies it.

Score components (all 0..1, stored in trace):
`relevance = w_sem*semantic + w_lex*lexical_norm`,
`final = W_REL*relevance + W_IMP*importance + W_TRUST*(trust*confidence) + W_REC*recency + W_UTIL*utility
+ scope_bonus`. Weights come from settings (`RANK_WEIGHTS_JSON`), are returned in the response and trace.
Recency = `exp(-age_days/RECENCY_HALF_LIFE_DAYS*ln2)`.

Rerank: greedy MMR-style selection that skips candidates whose embedding cosine to an already selected memory
exceeds `CONTEXT_DEDUP_THRESHOLD`. Token estimate = `ceil(chars/4)` (documented heuristic, reported as an estimate).
Memories are packed until the budget is reached; the trace records excluded items and reasons.

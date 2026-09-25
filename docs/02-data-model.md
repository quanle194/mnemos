# Data Model

Use UUIDv7 (or UUID if library support complicates V1), UTC timestamps, JSONB metadata, explicit tenant/workspace columns, and pgvector embedding columns with documented dimension per configured model.

## Core tables
### organizations
id, name, created_at.
### workspaces
id, organization_id, name, settings_json, created_at.
### projects
id, workspace_id, name, created_at.
### agents
id, workspace_id, name, kind, metadata_json, created_at.
### sessions
id, workspace_id, project_id, agent_id, started_at, ended_at, metadata_json.
### events
id, workspace_id, project_id, agent_id, session_id, task_id, type, payload_json, occurred_at, created_at. Immutable.
### working_memories
id, workspace_id, agent_id, session_id, key, content, importance, expires_at, created_at, updated_at.
### experiences
id, workspace_id, project_id, agent_id, session_id, task_id, task, observation, action, result, outcome, importance, confidence, metadata_json, created_at.
### episodes
id, workspace_id, project_id, agent_id, session_id, task_id, summary, outcome, importance, confidence, embedding, started_at, completed_at, metadata_json.
### memories
id, workspace_id, project_id nullable, agent_id nullable, type, scope_type, scope_id, title, content, status, confidence, trust_score, importance, utility_score, valid_from, valid_until, version, embedding, created_by_type, created_by_id, created_at, updated_at.
### memory_versions
id, memory_id, version, snapshot_json, change_reason, actor_type, actor_id, created_at.
### memory_evidence
id, memory_id, source_type, source_id, relation, weight, created_at.
### memory_relations
id, source_memory_id, target_memory_id, relation, metadata_json, created_at. Unique relation tuple.
### memory_feedback
id, memory_id, workspace_id, agent_id, session_id, task_id, value, note, created_at.
### conflicts
id, workspace_id, candidate_memory_id, existing_memory_id, conflict_type, status, analysis_json, resolution_json, created_at, resolved_at.
### dream_jobs
id, workspace_id, mode, status, trigger_type, input_window_json, result_json, error, started_at, completed_at, created_at.
### retrieval_traces
id, workspace_id, query, request_json, candidates_json, selected_json, context_tokens, latency_ms, created_at.
### audit_logs
id, workspace_id, actor_type, actor_id, action, resource_type, resource_id, before_json, after_json, created_at.

## Constraints/indexes
- Tenant/scope columns indexed on every tenant-owned table.
- Partial indexes for active memories.
- GIN/tsvector lexical index on title/content.
- pgvector ANN index after data volume justifies it; exact vector search is acceptable for tiny dev datasets.
- Unique `(memory_id, version)`.
- Enforce valid status/type/relation enums.
- No hard delete of memory through normal API; DELETE means archive unless explicit retention endpoint/policy exists.

## Lifecycle invariants
Only active/validated memories are eligible for normal context unless caller explicitly requests candidates. Superseded memories point to successor relation(s). Expired memories are excluded. Every promotion must have evidence or an explicitly audited privileged human/admin source.

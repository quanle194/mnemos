# ADR 0003 - Tenancy, API keys and RBAC baseline

Status: accepted

## Decision
- Tenant boundary = `organization`. Every tenant-owned row stores `organization_id` (and `workspace_id` where
  applicable). All repository queries filter on the caller's `organization_id` and allowed workspace IDs.
- Auth in V1 = API keys (`mnm_<prefix>_<secret>`). Only an HMAC-SHA256 (keyed with `API_KEY_PEPPER`/
  `API_BOOTSTRAP_SECRET`) of the key is stored. Keys have one role and optionally a list of allowed
  workspaces (null = all workspaces in the org).
- Roles: `admin`, `maintainer`, `agent`, `viewer`. Permissions: `memory:read`, `experience:write`,
  `memory:propose`, `feedback:write`, `memory:review`, `dream:run`, `workspace:manage`.
  - viewer: memory:read
  - agent: + experience:write, memory:propose, feedback:write
  - maintainer: + memory:review, dream:run
  - admin: + workspace:manage
- Cross-tenant access returns 404 (not 403) so IDs of other tenants are not confirmable.
- First organization/admin key is created through `POST /v1/admin/bootstrap` guarded by
  `API_BOOTSTRAP_SECRET` (or `mnemos admin bootstrap` CLI directly against the DB).
- The principal interface (`Principal`) is independent of API keys so OIDC can be added later.

Postgres row-level security was considered as defence in depth; deferred (documented limitation) because all
access already goes through tenant-scoped services and it is covered by isolation tests.

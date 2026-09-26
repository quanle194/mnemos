# Mnemos dashboard (`web/`)

Operational dashboard for Mnemos: React 19 + Vite 7 + TypeScript (strict), Tailwind CSS v4, shadcn-style
components (hand-written in `src/components/ui/`, Radix primitives), TanStack Query, React Router 7,
React Hook Form + Zod, Sonner and lucide-react.

## Quick start

```bash
cd web
npm ci
npm run dev            # http://localhost:5173 — proxies /api -> http://localhost:8000 (prefix stripped)
```

Start the API and worker first (`make dev` from the repo root starts Postgres/Redis, API, worker and this
dev server). Open the dashboard, paste an API key (from `POST /v1/admin/bootstrap` or
`mnemos admin bootstrap`) and pick a workspace.

## Scripts

| Command             | What it does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `npm run dev`       | Vite dev server with the `/api` proxy                                    |
| `npm run build`     | `tsc -b && vite build` → static files in `dist/`                         |
| `npm run preview`   | Serve `dist/` locally (same `/api` proxy)                                |
| `npm run lint`      | ESLint flat config (typescript-eslint, react-hooks, react-refresh)       |
| `npm run typecheck` | `tsc --noEmit` for app and tooling projects                              |
| `npm test`          | Vitest + Testing Library (jsdom), mocked API — deterministic, no network |
| `npm run test:live` | Drive the real app against a running API (see below)                     |
| `npm run format`    | Prettier write (`format:check` to verify)                                |

## Configuration

| Variable                | Where       | Default                 | Purpose                                                  |
| ----------------------- | ----------- | ----------------------- | -------------------------------------------------------- |
| `VITE_API_URL`          | build time  | `/api`                  | API base URL seen by the browser                         |
| `MNEMOS_DEV_API_TARGET` | dev/preview | `http://localhost:8000` | Where the dev server forwards `/api/*` (prefix stripped) |
| `MNEMOS_WEB_SOURCEMAP`  | build time  | unset                   | `true` emits source maps in `dist/`                      |

The API URL can also be overridden per browser at login (stored in `localStorage` together with the key
and active workspace). In production the dashboard is served at `/` and the API at `/api` on the same
origin; the nginx CSP (`connect-src 'self'`) intentionally blocks cross-origin API URLs there.

Production image: `docker build -f web/Dockerfile .` from the repo root (unprivileged nginx on `:8080`,
SPA fallback, `/healthz`). Readiness is read from `GET {API}/health/ready` (i.e. `/api/health/ready`).

## Layout

```
src/
  api/          client.ts (fetch wrapper, ApiError, If-Match, Idempotency-Key), types.ts (OpenAPI mirror),
                endpoints.ts (one function per operation), keys.ts (query keys), hooks/ (TanStack Query)
  auth/         session (localStorage-backed key/API URL/workspace), permissions from GET /v1/me
  app/          providers + routes
  components/   ui/ (shadcn-style primitives), layout/ (sidebar, header, switcher), common/ (shared pieces)
  lib/          pure helpers: graph-layout (force-directed), diff (history), metrics (eval labels), format
  pages/        one folder/file per screen
  test/         mock API router, fixtures, render helpers, opt-in live test
```

Behaviour worth knowing:

- Every POST write carries a fresh UUID `Idempotency-Key` (with a `getRandomValues` fallback for plain-HTTP
  deployments where `crypto.randomUUID` is unavailable). Search is a POST but sends no key.
- Memory edits/archive/review/promote send the version the user started from (`If-Match: "<version>"` or
  `expected_version`). A 409 shows the server's `current_version` and a "Reload latest version" action.
- A 401 from any query signs the user out. 4xx errors are never retried.
- Experience detail polls every 2 s while `processing_status` is `pending` (10 s after `failed`); dream detail
  polls while `queued`/`running`. Finished work invalidates dependent lists/stats once.
- Actions are hidden when `/v1/me` lacks the permission (`memory:propose`, `memory:review`, `feedback:write`,
  `experience:write`, `dream:run`, `workspace:manage`).

## `data-testid` conventions (for Playwright)

| Kind              | Pattern / examples                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation        | `nav-overview`, `nav-memories`, `nav-experiences`, `nav-dreams`, `nav-conflicts`, `nav-graph`, `nav-agents`, `nav-workspaces`, `nav-evals`, `nav-settings`, `nav-toggle` (mobile)                                                                                                                                                                                                                                                                                             |
| Header            | `workspace-switcher` (native `<select>`, value = workspace id), `current-role`, `theme-toggle`, `logout-button`                                                                                                                                                                                                                                                                                                                                                               |
| Login             | `login-form`, `login-api-key`, `login-api-url`, `login-submit`, `login-error`, `workspace-select-form`, `workspace-select`, `workspace-continue`                                                                                                                                                                                                                                                                                                                              |
| Lists             | `<entity>-list` table + `<entity>-row` rows with `data-id` (and `data-status` where relevant): `memory-*`, `experience-*`, `episode-*`, `dream-*`, `conflict-*`, `agent-*`, `project-*`, `workspace-*`, `api-key-*`, `eval-*`, `job-*`, `trace-*`, `audit-*`; row links `memory-row-link`, `experience-row-link`, `conflict-row-link`; `load-more`-style `<entity>-load-more`                                                                                                 |
| Forms             | `<form>-form`, fields `<form>-<field>`, submit `<form>-submit`: `propose-memory-*`, `experience-*` (`experience-task`, `experience-outcome`, …), `dream-form`/`dream-mode`/`dream-dedupe`/`dream-submit`, `agent-*`, `project-*`, `workspace-*`, `api-key-*`, `memory-edit-*`, `memory-search-form`/`-input`/`-submit`                                                                                                                                                        |
| Memory filters    | `memory-filter-q`, `memory-filter-status`, `memory-filter-type`, `memory-filter-layer`, `memory-filter-review`, `memory-filter-clear`; tabs `memories-tab-browse`, `memories-tab-search`                                                                                                                                                                                                                                                                                      |
| Search results    | `search-result` (`data-id`), `search-result-score`, `search-result-breakdown`, `search-result-reasons`, `memory-search-trace`                                                                                                                                                                                                                                                                                                                                                 |
| Memory detail     | `memory-detail` (`data-id`), `memory-title`, `memory-status-badge` (`data-status`), `memory-version`, `memory-content`, `memory-trust`, `memory-properties`, `memory-prop-*`; sections `memory-evidence` (`evidence-row`, `evidence-source`), `memory-history` (`history-row` with `data-version`, `history-reason`, `history-actor`, `history-diff`), `memory-relations` (`relation-row`, `relation-link`), `memory-usage` (`usage-row`), `memory-feedback` (`feedback-row`) |
| Memory actions    | `memory-edit-button`, `memory-archive-button`, `memory-approve-button`, `memory-reject-button`, `memory-promote-button`; feedback `feedback-value-<value>`, `feedback-note`, `feedback-submit`; conflict UI `memory-conflict-alert`, `memory-conflict-reload`, `memory-edit-base-version`; dialogs `<name>-dialog` with `<name>-dialog-confirm`                                                                                                                               |
| Experience detail | `experience-detail`, `experience-learning`, `experience-processing-status` (`data-status`), `experience-derived-memory`                                                                                                                                                                                                                                                                                                                                                       |
| Dreams            | `dream-detail`, `dream-status` (`data-status`), `dream-polling`, `dream-stats`, `dream-stat-<key>`, `dream-proposals`, `dream-applied`                                                                                                                                                                                                                                                                                                                                        |
| Conflicts         | `conflicts-tab-open/resolved/all`, `conflict-detail`, `conflict-candidate`, `conflict-existing` (+ `-status`, `-content`), `conflict-note`, `conflict-resolve-<resolution>`, `conflict-resolution`, `conflict-analysis`                                                                                                                                                                                                                                                       |
| Graph             | `graph-svg`, `graph-node` (`data-id`, `data-status`), `graph-edge` (`data-relation`), `graph-legend`, `graph-table`, `graph-color-mode`, `graph-include-inactive`                                                                                                                                                                                                                                                                                                             |
| Overview          | `stat-<key>` / `stat-<key>-value` (`active-memories`, `pending-review`, `open-conflicts`, `retrievals-24h`, …), `dist-*` bar lists                                                                                                                                                                                                                                                                                                                                            |
| Settings          | `settings-tab-general/jobs/traces`, `settings-api-url`, `settings-role`, `settings-permissions`, `settings-readiness-status`, `settings-provider-llm`, `job-retry`, `trace-detail`                                                                                                                                                                                                                                                                                            |
| States            | `loading`, `error-state`, `empty-state`                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Tests

`npm test` runs 70+ deterministic tests: API client (headers, idempotency, If-Match, error contract, network
errors), login flow, memory list/filters/search, memory detail (evidence/history/relations/usage/feedback),
feedback mutation, PATCH 409 conflict + reload, review/archive, experience form validation (Zod) and polling,
conflict resolution, dreams, graph, API keys, settings/jobs, evals, and pure helpers (force layout, snapshot
diff, metric labelling).

Live check against a real stack (bootstraps its own organization, so it is isolated):

```bash
MNEMOS_LIVE_API_URL=http://127.0.0.1:8000 MNEMOS_LIVE_BOOTSTRAP_SECRET=<API_BOOTSTRAP_SECRET> npm run test:live
```

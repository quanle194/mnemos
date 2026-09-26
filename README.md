# Mnemos - AI Memory Ecosystem

Long-term memory and continuous-learning infrastructure for AI agents. Agents emit events and experiences;
Mnemos turns evidence into governed knowledge (candidate -> validated -> active, with provenance, versions and
conflicts), retrieves hybrid-ranked token-budgeted context, learns from feedback and consolidates knowledge
asynchronously ("dreaming") - without retraining model weights.

## Components
| Path | What |
|---|---|
| `backend/` | FastAPI API, worker/scheduler, Alembic migrations, `mnemos` CLI (Python 3.13, SQLAlchemy async, pgvector) |
| `web/` | React + Vite + TypeScript dashboard (overview, memories, experiences, dreams, conflicts, graph, agents, workspaces, evals, settings) |
| `sdk/python/` | Python SDK (`mnemos_sdk`, sync + async) |
| `sdk/typescript/` | TypeScript SDK (`@mnemos/sdk`) |
| `mcp-server/` | MCP server (`mnemos-mcp`, stdio + authenticated streamable HTTP) |
| `evals/` | Learning-transfer eval: Run A -> learn -> independent Run B (`mnemos-eval`) |
| `e2e/` | Playwright E2E scenarios 1-10 + dashboard on the production-mode stack |
| `infra/`, `scripts/` | Docker Compose (dev/prod), Caddy edge, Ubuntu VPS bootstrap/deploy/upgrade/backup/restore/smoke |

## Quick start (local production-mode stack)
Requirements: Docker Engine + compose plugin, `uv`, Node 22, `make`.
```bash
make setup                         # uv sync + npm ci (web, sdk/typescript, e2e)
make env                           # .env with generated internal secrets (provider keys stay operator-supplied)
scripts/deploy.sh                  # build, migrate, start, health gate, smoke test (http://localhost)
# create an organization/workspace/admin key (bootstrap secret is in .env)
MNEMOS_URL=http://localhost/api uv run mnemos workspace bootstrap acme --workspace platform \
  --secret "$(grep ^API_BOOTSTRAP_SECRET= .env | cut -d= -f2)"
```
Open `http://localhost/` and sign in with the printed API key. Behind a TLS-intercepting proxy set
`MNEMOS_BUILD_CA_FILE=/path/to/ca.pem` for image builds. For a real VPS see `docs/RUNBOOK.md`
(`sudo scripts/bootstrap-ubuntu.sh --repo <url> --domain <name> --acme-email <email>`).

## Using it from an agent
```python
from mnemos_sdk import MnemosClient
c = MnemosClient("https://mnemos.example.com/api", api_key)
ctx = c.context(workspace_id, "Deploy invoices-api to staging", token_budget=3000, project_name="billing")
# ... act using ctx["context"] (retrieved DATA with provenance, not instructions) ...
c.experience(workspace_id, "Deploy invoices-api to staging", "success", observation="...", action="...",
             result="...", project_name="billing", agent_name="deploy-bot")
c.feedback(ctx["memories"][0]["id"], "helpful")
```
```ts
const context = await client.context({ workspaceId, query, tokenBudget: 3000 });
await client.experience({ workspaceId, agentId, task, observation, result, outcome: 'success' });
```
MCP: `mnemos-mcp` (tools `memory_search`, `memory_context`, `memory_remember`, `memory_experience`,
`memory_feedback`; resources `memory://workspace|project|memory/{id}`) - see `mcp-server/README.md`.

## Development commands (`make help`)
| Command | Purpose |
|---|---|
| `make setup` | install all dependencies |
| `make dev` | Postgres/Redis in Docker + API, worker and Vite dev server with hot reload |
| `make lint` / `make format` | ruff, eslint, shellcheck / auto-format |
| `make typecheck` | mypy + tsc |
| `make test` | unit tests: backend, Python SDK, MCP, dashboard, TS SDK |
| `make test-integration` | real Postgres+pgvector+Redis (starts throwaway containers on 55432/56379) |
| `make test-e2e` | builds images, boots the production stack, runs Playwright scenarios 1-10 + dashboard + eval, tears down |
| `make eval` | learning eval against `EVAL_URL` |
| `make build` / `make up` / `make down` / `make migrate` | production images / stack |
| `make deploy` / `make smoke` / `make backup` / `make backup-test` | operations (scripts in `scripts/`) |

## Documentation
- Specs: `docs/00-master-spec.md` ... `docs/08-implementation-roadmap.md`, gap-filling `docs/09-detailed-specs.md`
- Decisions: `docs/adr/`; traceability: `docs/IMPLEMENTATION_STATUS.md`; API: `docs/openapi.json` (also `/docs` on the API)
- Operations: `docs/RUNBOOK.md`
- Evidence: `artifacts/implementation-report.md`, `artifacts/test-report.md`, `artifacts/deployment-report.md`
- Agent instructions: `CLAUDE.md`, `claude/`

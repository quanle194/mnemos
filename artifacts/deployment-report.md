# Deployment report

Environment: build sandbox, Ubuntu 24.04 (container), Docker 29.3.1 + compose v5.1.1 (daemon started manually;
Docker Hub rate-limited so the daemon uses the `mirror.gcr.io` pull-through mirror - image names in the repo are the
canonical ones). Image builds pass the sandbox's TLS-intercepting proxy CA with
`MNEMOS_BUILD_CA_FILE=/root/.ccr/ca-bundle.crt` (BuildKit secret; never stored in images).

## Topology (infra/docker-compose.prod.yml, ADR 0007)
caddy (only published service: 80/443) -> web (nginx-unprivileged :8080, SPA) at `/`, api (:8000) at `/api/*`
(prefix stripped, `/api/metrics` blocked), optional mcp (:8765, profile `mcp`, bearer token required) at `/mcp`
when `MCP_ROUTE=enabled`; worker (health :8001 internal); migrate (one-shot, gates api/worker); postgres
(pgvector 0.8.0-pg16) + redis 7.4 (AOF, password) on an `internal: true` network with named volumes. App containers
run non-root, read-only root FS where possible, healthchecks, restart policies, CPU/memory limits, log rotation.
Images: `mnemos/api` 476 MB, `mnemos/web` 74.7 MB.

## Executed deployment flow (VPS-equivalent, this host, port 80, `APP_ENV=production`, fake providers)
| Step | Command | Result |
|---|---|---|
| Env | `scripts/init-env.sh --output .env` | generated POSTGRES/REDIS passwords, bootstrap secret, pepper, MCP token (mode 600); provider keys left operator-supplied |
| Deploy | `scripts/deploy.sh --with-mcp` | preflight, build, postgres+redis healthy, `migrations applied: 0001`, services healthy, release recorded, smoke **12/12** (47 s) |
| Core flow (CLI) | `mnemos workspace bootstrap` -> `mnemos experience create --wait` -> `mnemos context --project billing --agent agent-b` | lesson learned `active`, returned to agent B with evidence (~145 tokens) |
| Upgrade | `scripts/upgrade.sh --with-mcp` (new commit) | pre-migration verified backup, migrate, health, smoke **12/12** |
| Rollback | `scripts/upgrade.sh --rollback` | previous images, schema-compatibility check, smoke **12/12** |
| Re-upgrade | `scripts/upgrade.sh --with-mcp` | smoke **12/12**; `backups/state/releases.log` shows deploy/deploy/rollback/deploy |
| Backup drill | `make backup-test` | `pg_dump -Fc` + sha256 + manifest; isolated restore in a throwaway pgvector container: checksum, alembic 0001 = live head, 15 tables, row counts = manifest, pgvector works -> **VERIFIED** |
| Restart | `docker compose restart` (all services) | active memories 11 -> 11, evidence 22 -> 22, no pending jobs; smoke **12/12** |
| MCP | `curl` via Caddy with `MCP_ROUTE=enabled` | 401 without token; `initialize` succeeds with token |
| Eval | `mnemos-eval --url http://localhost/api` | PASS (`artifacts/eval-report-prod.json`) |

Smoke test checks: web root + SPA deep link, `/api/health/live`, `/api/health/ready` (db, redis, migration, pgvector),
metrics not public, tenant bootstrap, ingest, learn -> active memory, retrieval by a second agent, ports 5432/6379
closed, only caddy publishes ports. Filtered logs: `artifacts/logs/prod-*.log`.

## Also verified by the infrastructure pass (see RUNBOOK)
`scripts/bootstrap-ubuntu.sh` executed for real as root on this Ubuntu 24.04 host with `--skip-firewall` (deploy
user, clone, `.env`, build, deploy, smoke 12/12; second run idempotent), `restore.sh --target live --yes`, restore
verification failing correctly on tampered counts/corrupted dump/wrong revision, `caddy validate` in domain and
HTTP modes, `docker compose config` for all profiles.

## Not verifiable here (operator inputs, not blockers)
- Real domain + automatic HTTPS (needs DNS pointing at the VPS and ports 80/443 reachable from the internet):
  set `SITE_ADDRESS=<domain>` / `ACME_EMAIL` (`init-env.sh --domain X --acme-email Y`). Caddyfile validated in domain mode.
- ufw firewall enablement and Docker installation branch (Docker already present; ufw would break the sandbox
  network) - exercised with `--dry-run`.
- systemd backup timer (no systemd in the sandbox; unit files + cron fallback provided).
- Real LLM/embedding providers: set `LLM_PROVIDER=openai|ollama`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
  `EMBEDDING_*` (dimension must match `EMBEDDING_DIMENSIONS` at first migration).
- Off-site backup copy target (hook documented in RUNBOOK).

## Exact commands for an operator
```bash
sudo scripts/bootstrap-ubuntu.sh --repo <git-url> --branch main --domain mnemos.example.com --acme-email ops@example.com
# or on an existing host:
scripts/init-env.sh --domain mnemos.example.com --acme-email ops@example.com   # then edit provider keys in .env
scripts/deploy.sh [--with-mcp]
scripts/upgrade.sh --ref <tag>        # upgrade (backup before migrate)
scripts/upgrade.sh --rollback         # roll back application images
make backup-test                      # verified backup + isolated restore drill
scripts/smoke-prod.sh                 # production smoke test
```

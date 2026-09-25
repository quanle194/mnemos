# Mnemos Operations Runbook - single Ubuntu VPS

This runbook covers installing, operating, backing up, upgrading and troubleshooting Mnemos on a single Ubuntu VPS with
Docker Compose. The topology is fixed by [ADR 0007](adr/0007-deployment-topology.md). All commands are run from the
repository checkout (default `/opt/mnemos/app`) as the deploy user (default `mnemos`), unless marked `sudo`.

```
                    Internet / private network
                              |
                   :80 / :443 (only published ports)
                              |
                       +-------------+
                       |    caddy    |  TLS (automatic HTTPS or HTTP-only), security headers,
                       +-------------+  JSON access logs, body limit, /api/metrics blocked
               /           |            \
         /* (SPA)      /api/* (strip)    /mcp (optional, token)
      +-------+       +-------+          +-------+
      |  web  |       |  api  |<---------|  mcp  |      network "edge"
      +-------+       +-------+          +-------+
                          |    +---------+
                          |    | worker  |---> LLM / embedding providers   network "egress"
                          |    +---------+
                    +----------+  +-------+
                    | postgres |  | redis |                                 network "backend" (internal: true)
                    | pgvector |  +-------+
                    +----------+
          one-shot "migrate" runs before api/worker start
```

| Service | Image | Port (internal) | Health |
|---|---|---|---|
| caddy | `caddy:2.8-alpine` | 80, 443 (published) | `http://127.0.0.1:2080/healthz` (loopback) |
| web | `${MNEMOS_IMAGE_PREFIX}/web:${MNEMOS_VERSION}` (nginx-unprivileged, uid 101) | 8080 | `/healthz` |
| api | `${MNEMOS_IMAGE_PREFIX}/api:${MNEMOS_VERSION}` (uid 10001, read-only rootfs) | 8000 | `/health/live`, `/health/ready`, `/metrics` |
| worker | same image, `mnemos worker` | 8001 | `/health/live`, `/health/ready`, `/metrics` |
| migrate | same image, `mnemos migrate` (one-shot) | - | exit code |
| postgres | `pgvector/pgvector:0.8.0-pg16` | 5432 (never published) | `pg_isready` |
| redis | `redis:7.4-alpine` (AOF, password) | 6379 (never published) | `redis-cli ping` |
| mcp (profile `mcp`) | same image, `mnemos-mcp` | 8765 | `/healthz` |
| ollama (profile `ollama`) | `ollama/ollama:0.12.3` | 11434 | `ollama list` |

Files: `infra/docker-compose.prod.yml`, `infra/Caddyfile`, `infra/env.production.example` (every variable documented),
`infra/systemd/mnemos-backup.{service,timer}`, `scripts/*.sh` (all support `--help`).

Convenience alias used below (run from the checkout):

```bash
alias dc='docker compose -p mnemos -f infra/docker-compose.prod.yml --env-file .env'
```

---

## 1. Prerequisites

* Ubuntu 24.04 or 22.04 LTS (Debian 12 works), x86_64 or arm64, root/sudo access over SSH.
* Sizing (see section 14): minimum 2 vCPU / 4 GB RAM / 40 GB SSD; recommended 4 vCPU / 8 GB / 80 GB.
* Outbound HTTPS to: `download.docker.com` (Docker install), Docker Hub (base images), `pypi.org` +
  `files.pythonhosted.org` and `registry.npmjs.org` (image builds), your git host, your LLM/embedding provider and,
  in domain mode, Let's Encrypt / ZeroSSL.
* Operator decisions (never invented by the scripts):
  * a domain name (for HTTPS) or an HTTP-only deployment on a private network/tunnel;
  * LLM/embedding provider credentials (`LLM_*`, `EMBEDDING_*`). Without them Mnemos runs with the deterministic
    built-in `fake` providers, which is fine for evaluation and smoke tests but not for real learning quality;
  * `EMBEDDING_DIMENSIONS` **before the first deploy** (the pgvector column size is fixed by the first migration).

## 2. Choose the TLS mode

| Mode | `.env` | When |
|---|---|---|
| Automatic HTTPS | `SITE_ADDRESS=mnemos.example.com`, `PUBLIC_WEB_URL=https://mnemos.example.com`, `PUBLIC_API_URL=https://mnemos.example.com/api`, `ALLOWED_HOSTS=mnemos.example.com`, optional `ACME_EMAIL` | Public VPS with a DNS A/AAAA record pointing at it and ports 80+443 reachable (ACME HTTP/TLS challenges). Certificates persist in the `caddy_data` volume. |
| HTTP only | `SITE_ADDRESS=:80` (default) | Private network/VPN (e.g. Tailscale/WireGuard), or behind a TLS-terminating tunnel/load balancer (Cloudflare Tunnel, cloud LB). Never expose HTTP-only mode directly on the internet: API keys would travel in clear text. |

Behind a tunnel on the same host you can keep Caddy off the public interface with `HTTP_PORT=127.0.0.1:8080`
(the value is inserted verbatim into the port mapping). `TRUSTED_PROXIES` (default `private_ranges`) controls whose
`X-Forwarded-For` Caddy trusts.

## 3. Bootstrap a fresh VPS (one command)

```bash
# as root on the VPS
git clone https://github.com/<org>/mnemos.git /root/mnemos-bootstrap
sudo /root/mnemos-bootstrap/scripts/bootstrap-ubuntu.sh \
  --repo https://github.com/<org>/mnemos.git --branch main \
  --domain mnemos.example.com --acme-email ops@example.com      # omit both for HTTP-only mode
```

Preview first with `--dry-run` (prints every action, needs no root). What it does, idempotently:

1. checks the OS and resources, installs base packages (`ca-certificates curl git gnupg jq openssl netcat-openbsd ufw`);
2. installs Docker Engine + buildx + compose plugin from Docker's apt repository if missing (removes conflicting
   `docker.io`/`podman-docker` packages first), writes `/etc/docker/daemon.json` with log rotation only if absent;
3. ufw baseline: deny incoming, allow OpenSSH (or `--ssh-port N`), 80/tcp, 443/tcp, 443/udp (HTTP/3). Skip with
   `--skip-firewall`. **Docker-published ports bypass ufw** - that is why only Caddy publishes ports;
4. creates the deploy user (`--user`, default `mnemos`, member of `docker` = root-equivalent) and
   `/opt/mnemos` (`--dir`): `app/` (checkout), `backups/` (mode 700);
5. clones the repo, or fetches + fast-forwards an existing checkout;
6. creates `/opt/mnemos/app/.env` with `scripts/init-env.sh` **only if it does not exist**: random
   `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `API_BOOTSTRAP_SECRET`, `API_KEY_PEPPER`, `MNEMOS_MCP_TOKEN`
   (`openssl rand -hex 32`); provider credentials are left empty;
7. installs and enables the nightly `mnemos-backup.timer` (or prints a cron line when systemd is absent);
8. runs `scripts/deploy.sh` as the deploy user (skip with `--skip-deploy`; pass extra flags with `--deploy-args`).

Other flags: `--http-port/--https-port`, `--project NAME` (compose project, default `mnemos`),
`--skip-docker-install`, `--no-backup-timer`. Private repositories: add a read-only deploy key for the deploy user or
use an HTTPS token URL.

### Manual install on an existing Docker host

```bash
git clone https://github.com/<org>/mnemos.git && cd mnemos
scripts/init-env.sh --output .env [--domain mnemos.example.com --acme-email ops@example.com]
$EDITOR .env                 # providers, EMBEDDING_DIMENSIONS, resource limits
scripts/deploy.sh
```

## 4. Deploy / redeploy

```bash
scripts/deploy.sh [--version TAG] [--no-build] [--with-mcp] [--with-ollama] [--skip-backup] [--skip-smoke]
```

Stages (each failure prints rollback guidance and the exact inspect/rollback commands):

1. **preflight** - Docker/compose present, `.env` validation (required secrets set, no `CHANGE_ME` placeholders,
   `API_BOOTSTRAP_SECRET` >= 24 chars, URL-safe DB/Redis passwords, provider settings consistent, MCP token when
   `--with-mcp`), `docker compose config` valid, free disk space;
2. **images** - build locally (`api` and `web`, tag = `git describe` of the checkout or `--version`), or with
   `--no-build` pull `${MNEMOS_IMAGE_PREFIX}/{api,web}:<TAG>` from a registry (images already present locally, e.g.
   via `docker load`, are accepted);
3. **postgres + redis** started and healthy;
4. **pre-migration backup** (`backups/mnemos-<project>-<ts>-pre-deploy-<TAG>.dump`) when the database already exists;
5. **migrate** (`docker compose run --rm migrate` = `mnemos migrate`, alembic `upgrade head`);
6. **application** - `docker compose up -d --wait` (api/worker only start after `migrate` completed successfully;
   waits for every healthcheck);
7. **readiness gate** through Caddy: `GET <public URL>/api/health/ready` must return 200 (database + redis OK);
8. **release record** - `MNEMOS_VERSION=<TAG>` is written back to `.env`, and appended to
   `backups/state/releases.log`;
9. **smoke test** (`scripts/smoke-prod.sh`, section 6).

Changing `.env` (providers, limits, secrets) = edit and re-run `scripts/deploy.sh` (or `dc up -d` for a quick
recreate without build/backup/smoke).

## 5. First organization, workspace and API key

Exactly once, through the edge with the bootstrap secret from `.env`:

```bash
SECRET=$(grep ^API_BOOTSTRAP_SECRET= .env | cut -d= -f2)
curl -fsS -X POST https://mnemos.example.com/api/v1/admin/bootstrap \
  -H "X-Bootstrap-Secret: $SECRET" -H 'Content-Type: application/json' \
  -d '{"organization_name":"acme","workspace_name":"default"}'
# -> {"organization_id": "...", "workspace_id": "...", "api_key": "mnm_...", "api_key_id": "..."}
```

or directly against the database (no HTTP): `dc exec api mnemos admin bootstrap --organization acme --workspace default`.
The `api_key` is shown once - store it in your password manager. It is an **admin** key; give agents their own
least-privilege keys:

```bash
curl -fsS -X POST https://mnemos.example.com/api/v1/api-keys -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"name":"agent-ci","role":"agent","workspace_ids":["<workspace_id>"]}'
```

Roles: `admin`, `maintainer`, `agent`, `viewer`. Revoke with `DELETE /api/v1/api-keys/<id>`.

## 6. Verify ingest -> learn -> retrieve

```bash
scripts/smoke-prod.sh --env-file .env                 # base URL derived from SITE_ADDRESS/HTTP_PORT
scripts/smoke-prod.sh --base-url https://mnemos.example.com --api-key "$ADMIN_KEY"
```

Checks (non-zero exit on any failure, compact PASS/FAIL report): web root + SPA deep link, `/api/health/live`,
`/api/health/ready` (db+redis), `/api/metrics` blocked at the edge, tenant bootstrap (dedicated `mnemos-smoke`
organization, fresh `smoke-<run>` workspace per run - production tenants are never touched), experience ingest,
learning until the derived memory is **active**, `/v1/context` from a **different agent** returns that memory,
Postgres/Redis ports closed on the target host, and (when Docker is reachable) no service other than Caddy publishes
ports. `deploy.sh` stores the smoke admin key in `backups/state/smoke-admin.key` (mode 600) and reuses it.

Manual equivalent: `POST /api/v1/experiences`, poll `GET /api/v1/experiences/<id>` until
`processing_status=processed` and `learning.memories[].status=active`, then `POST /api/v1/context`.

## 7. Dashboard

Open `PUBLIC_WEB_URL` (e.g. `https://mnemos.example.com/`). Sign in with an API key (admin for workspace/key
management, `viewer` for read-only operators). The dashboard calls the API on the same origin under `/api`, so no
CORS configuration is needed. The key is kept in the browser's storage - use per-person keys and revoke them on
departure.

## 8. Day-2 operations

```bash
dc ps                                    # status + health of every service
dc logs -f --tail=200 api worker         # structured JSON logs (request/job IDs)
dc logs --since 1h caddy | grep '"status":5'
dc restart worker
dc exec api mnemos jobs drain            # process queued jobs synchronously (debugging)
dc exec api mnemos jobs schedule-once    # run one lifecycle/dream scheduler tick
dc down                                  # stop (volumes kept); `down -v` DELETES ALL DATA
```

Log rotation: every service uses the json-file driver with `LOG_MAX_SIZE` (10m) x `LOG_MAX_FILE` (5).
Caddy access logs are JSON on stdout; `Authorization`/`Cookie` are redacted by Caddy, `X-Api-Key` and
`X-Bootstrap-Secret` are dropped by a log filter.

## 9. Backups

What is backed up: the PostgreSQL database (all tenants, memories, evidence, audit logs, jobs). Redis only holds
ephemeral state (wake-ups, rate-limit counters, locks, heartbeats) and is optional (`--with-redis`). **`.env` is not
part of the backup** - keep a copy in your secret manager: `API_KEY_PEPPER` is required to validate existing API keys.

```bash
scripts/backup.sh [--verify] [--label TEXT] [--keep-days N] [--keep-min N] [--with-redis] [--dir DIR]
```

* `pg_dump -Fc` via `docker compose exec -T postgres`, written atomically to `BACKUP_DIR` (mode 600, dir 700):
  `mnemos-<project>-<UTC timestamp>[-label].dump`, `.dump.sha256`, `.manifest.json`.
* The manifest (alembic revision, pgvector/server version, **row counts of key tables**) is captured inside the
  **same exported snapshot** as the dump (`pg_export_snapshot()` + `pg_dump --snapshot`), so counts match the dump
  exactly even under concurrent writes.
* `pg_restore -l` TOC check (table data present for every key table and `alembic_version`).
* Retention: files older than `BACKUP_KEEP_DAYS` (14) are pruned, but the newest `BACKUP_KEEP_MIN` (3) are always
  kept. A lock file prevents concurrent runs.
* `--verify` runs the isolated restore verification (section 10) on the new dump.
* Off-site copy: `BACKUP_OFFSITE_CMD=/opt/mnemos/offsite.sh` runs after each successful backup with `BACKUP_FILE`,
  `BACKUP_CHECKSUM`, `BACKUP_MANIFEST`, `BACKUP_DIR` exported. Example with an rclone `crypt` remote
  (encrypts client-side):

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  for f in "$BACKUP_FILE" "$BACKUP_CHECKSUM" "$BACKUP_MANIFEST"; do
    rclone copy "$f" mnemos-crypt:backups/
  done
  ```

**Nightly schedule** (installed by bootstrap): `mnemos-backup.timer` runs `scripts/backup.sh --verify` at 02:30
(+ up to 20 min jitter, `Persistent=true`). Check with `systemctl list-timers mnemos-backup.timer` and
`journalctl -u mnemos-backup.service`. Manual install: copy `infra/systemd/mnemos-backup.{service,timer}` to
`/etc/systemd/system/`, adjust paths/user, `systemctl daemon-reload && systemctl enable --now mnemos-backup.timer`.
Cron alternative:

```cron
30 2 * * * cd /opt/mnemos/app && MNEMOS_PROJECT=mnemos scripts/backup.sh --verify --env-file /opt/mnemos/app/.env >>/opt/mnemos/backups/backup.log 2>&1
```

**Volume snapshot option** (in addition to, not instead of, dumps): provider block-storage snapshots of
`/var/lib/docker/volumes/mnemos_pgdata` are crash-consistent only if the whole volume is snapshotted atomically;
for a guaranteed-consistent snapshot run `dc stop api worker postgres`, snapshot, `dc up -d --wait`.
A dump is only considered a backup once it has passed an isolated restore (section 10).

## 10. Restore drill and restore

**Drill** (run after setup, after upgrades and at least monthly; `make backup-test` runs the same):

```bash
scripts/backup-test.sh              # backup.sh + restore.sh --verify on that dump; --keep to retain files
scripts/restore.sh --verify         # verify the newest existing dump (or --file PATH)
```

`restore.sh --verify` (the default mode) restores into a **throwaway** container from the same pgvector image with
`--network none`, an anonymous volume and no published ports, then checks: sha256; `alembic_version` present, equal to
the manifest and equal to the deployed code head (`--allow-older-schema` accepts pre-upgrade dumps); core tables
exist; row counts equal the manifest; `vector` extension present and the distance operator works. The container is
always removed; a `.verify.json` report is written next to the dump.

**Real restore** into the running stack (DESTRUCTIVE):

```bash
scripts/restore.sh --target live --file backups/mnemos-mnemos-<ts>.dump            # asks you to type the project name
scripts/restore.sh --target live --file backups/mnemos-mnemos-<ts>.dump --yes      # non-interactive (10 s countdown)
```

Sequence: isolated verification -> safety backup of the current DB (`-pre-restore`) -> stop api/worker/mcp ->
`DROP DATABASE ... WITH (FORCE)` + recreate -> `pg_restore --single-transaction --exit-on-error` -> `mnemos migrate`
(upgrades an older dump to head) -> start api/worker and wait for health -> compare live row counts with the manifest.
Then run `scripts/smoke-prod.sh`.

**Disaster recovery on a new host:** bootstrap the new VPS with `--skip-deploy`, put the saved `.env` in place
(same `API_KEY_PEPPER`!), copy the dump + `.sha256` + `.manifest.json` into `/opt/mnemos/backups`, run
`scripts/deploy.sh --skip-smoke`, then `scripts/restore.sh --target live --file <dump> --yes` and
`scripts/smoke-prod.sh`. Update DNS last.

## 11. Upgrade and rollback

Policy:

* **Versioned images**: every deploy is tagged (`git describe` or `--version`); previous images stay on the host
  (or in your registry) for rollback. `MNEMOS_VERSION` in `.env` always names the running release.
* **Backup before migrate**: `deploy.sh` takes a `pre-deploy-<TAG>` dump before running migrations on an existing DB.
* **Health gate**: compose healthchecks + `/api/health/ready` through Caddy + the smoke test.
* **Expand / migrate / contract** for schema changes: release N adds (new tables, nullable columns, new indexes,
  dual-writes); release N+1 backfills/switches reads; only release N+2 drops or renames old structures. Each release
  must run against the previous release's schema, which keeps application rollbacks safe.

```bash
scripts/upgrade.sh --ref v1.3.0          # fetch + checkout tag, then deploy.sh (backup, migrate, gate, smoke)
git pull --ff-only && scripts/deploy.sh  # equivalent for a branch-tracking install
scripts/deploy.sh --no-build --version 1.3.0   # registry-based (MNEMOS_IMAGE_PREFIX=ghcr.io/<org>/mnemos)
```

Rollback of the **application** (images only, no migrations run):

```bash
scripts/upgrade.sh --rollback                 # previous release from backups/state/releases.log
scripts/upgrade.sh --rollback --to 1.2.0
```

It first checks that the target release knows the database's current alembic revision. If a newer migration is
present it refuses and explains the options: `--force` if that migration was additive (expand phase), or restore the
`pre-deploy` backup with `scripts/restore.sh --target live --file <pre-deploy dump>` (data written since then is lost)
and roll back afterwards. Downgrade migrations (`dc run --rm migrate migrate --downgrade --revision <rev>`) are a last resort.

Publishing images to a registry (CI or workstation):

```bash
docker build -f backend/Dockerfile --build-arg VERSION=1.3.0 -t ghcr.io/<org>/mnemos/api:1.3.0 .
docker build -f web/Dockerfile --build-arg VERSION=1.3.0 -t ghcr.io/<org>/mnemos/web:1.3.0 .
docker push ghcr.io/<org>/mnemos/api:1.3.0 && docker push ghcr.io/<org>/mnemos/web:1.3.0
```

## 12. Optional: MCP endpoint

The MCP server (streamable HTTP) runs from the same image under the compose profile `mcp` and is routed at `/mcp`
only when `MCP_ROUTE=enabled`. Clients must send `Authorization: Bearer <MNEMOS_MCP_TOKEN>`; the server refuses to
start on a non-loopback bind without a token.

1. Create an agent key scoped to one workspace (section 5) and set `MNEMOS_MCP_API_KEY`, `MNEMOS_MCP_WORKSPACE_ID`.
2. Set `MCP_ROUTE=enabled`; optionally `MNEMOS_MCP_ALLOWED_HOSTS=mnemos.example.com` (DNS-rebinding protection).
3. `scripts/deploy.sh --with-mcp` (keep passing `--with-mcp` on later deploys).
4. Client config: URL `https://mnemos.example.com/mcp`, header `Authorization: Bearer <MNEMOS_MCP_TOKEN>`.

With `MCP_ROUTE=disabled` (default) `/mcp` answers 404 at the edge.

## 13. Optional: local models with Ollama

```bash
# .env: LLM_PROVIDER=ollama, LLM_BASE_URL=http://ollama:11434, LLM_MODEL=llama3.1:8b,
#       EMBEDDING_PROVIDER=ollama, EMBEDDING_BASE_URL=http://ollama:11434, EMBEDDING_MODEL=nomic-embed-text,
#       EMBEDDING_DIMENSIONS=768 (before the first deploy!)
scripts/deploy.sh --with-ollama
dc --profile ollama exec ollama ollama pull llama3.1:8b
dc --profile ollama exec ollama ollama pull nomic-embed-text
```

Needs roughly 8 GB RAM extra for an 8B model (`OLLAMA_MEM_LIMIT`, default 6g); CPU-only inference is slow.

## 14. Resource sizing and limits

Defaults (in `.env`, applied as `deploy.resources.limits`) target a 4 vCPU / 8 GB VPS:

| Service | CPUs | Memory | Notes |
|---|---|---|---|
| postgres | 2.0 | 2g | `PG_SHARED_BUFFERS=512MB`, `PG_EFFECTIVE_CACHE_SIZE=1536MB`, `PG_MAX_CONNECTIONS=100`, shm 256m |
| api | 1.5 | 1g | `API_WORKERS=2` uvicorn processes, DB pool 10+10 each |
| worker | 1.5 | 1g | `WORKER_CONCURRENCY=4` |
| redis | 0.5 | 384m | `REDIS_MAXMEMORY=256mb`, `allkeys-lru` (only ephemeral keys), AOF everysec |
| caddy / web / mcp | 0.5 each | 256m / 128m / 384m | |

For a 2 vCPU / 4 GB host: `POSTGRES_MEM_LIMIT=1g`, `PG_SHARED_BUFFERS=256MB`, `PG_EFFECTIVE_CACHE_SIZE=768MB`,
`API_WORKERS=1`, `API_MEM_LIMIT=768m`, `WORKER_MEM_LIMIT=768m`. Storage grows roughly by
(text + 4 bytes x `EMBEDDING_DIMENSIONS`) per experience/memory plus indexes; keep 2x the database size free for
dumps and restore drills.

Scaling on one host: raise `API_WORKERS` (keep total DB connections below `PG_MAX_CONNECTIONS`); add worker replicas
with `dc up -d --scale worker=2` (the Postgres job queue uses `FOR UPDATE SKIP LOCKED` leases, so replicas are safe).
Beyond one host, move Postgres to a managed service and run api/worker on several hosts behind a load balancer.

## 15. Security checklist

- [ ] Only 22, 80, 443 reachable from the internet (`ufw status`; `scripts/smoke-prod.sh` checks 5432/6379 and
      that only Caddy publishes ports). Never add `ports:` to other services - Docker bypasses ufw.
- [ ] Domain mode (HTTPS) on the public internet; HTTP-only only on private networks/tunnels.
- [ ] `.env` is mode 600, owned by the deploy user, never committed, copied to a secret manager.
- [ ] Secrets generated randomly (`scripts/init-env.sh`); `API_BOOTSTRAP_SECRET` >= 24 chars (the API refuses to start
      otherwise in production).
- [ ] Per-agent, workspace-scoped, least-privilege API keys; the bootstrap admin key stored offline.
- [ ] Key rotation: API keys - create new, deploy to agents, `DELETE /api/v1/api-keys/<old>`.
      `API_BOOTSTRAP_SECRET`, `MNEMOS_MCP_TOKEN`, `REDIS_PASSWORD` - change in `.env`, `scripts/deploy.sh`.
      `POSTGRES_PASSWORD` - first `dc exec postgres psql -U mnemos -d mnemos -c "ALTER USER mnemos PASSWORD '<new hex>'"`,
      then update `.env` and `scripts/deploy.sh`. `API_KEY_PEPPER` - never, unless compromised (then every API key must
      be re-issued).
- [ ] `/api/metrics` and the worker metrics port stay internal (blocked at Caddy / not routed).
- [ ] MCP only with `MCP_ROUTE=enabled` + token; otherwise `/mcp` is 404.
- [ ] Containers: app images run as non-root (uid 10001 / 101) with read-only root filesystems, `cap_drop: ALL`,
      `no-new-privileges`; Postgres/Redis on an `internal: true` network without internet access.
- [ ] Nightly verified backups running, off-site copy configured, restore drill passed in the last 30 days.
- [ ] OS security updates (`unattended-upgrades`), SSH key-only auth, `docker` group membership limited to the deploy
      user; rebuild images periodically (`scripts/deploy.sh --pull-base`) for base-image patches.

## 16. Observability

* Logs: `dc logs` (JSON). Useful filters: `dc logs api | grep '"level":"error"'`,
  `dc logs worker | grep -E 'job_failed_will_retry|job_dead|worker_loop_error'`.
* Health: `curl -s <public URL>/api/health/ready | jq` shows database/pgvector/migration, queue depth per status,
  live workers and providers. Worker: `dc exec worker mnemos-healthcheck http://127.0.0.1:8001/health/ready`.
* Metrics (Prometheus text format, internal only):
  `dc exec -T api python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/metrics').read().decode())"`
  (worker: port 8001). To scrape continuously, run Prometheus/Grafana Agent as an extra compose service attached to
  the `backend` network (targets `api:8000/metrics`, `worker:8001/metrics`) via an override file - never publish the
  metrics ports. Note each uvicorn worker process has its own registry.
* Tracing: set `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env` to export OpenTelemetry traces.
* Audit trail: `audit_logs` table and the dashboard (memory history, evidence, retrieval traces).

## 17. Troubleshooting

| Symptom | Check / fix |
|---|---|
| `deploy.sh` preflight fails | Read the listed variables; regenerate secrets with `openssl rand -hex 32`; placeholders `CHANGE_ME*` must be replaced. |
| Image build fails with TLS/certificate errors behind a corporate proxy | `MNEMOS_BUILD_CA_FILE=/path/ca.pem scripts/deploy.sh` (CA passed as a BuildKit secret, never stored in images). |
| Docker Hub rate limit (`toomanyrequests`) | `docker login`, or a registry mirror in `/etc/docker/daemon.json` (`"registry-mirrors": ["https://mirror.gcr.io"]`), restart Docker. |
| `migrate` failed | `dc logs migrate`; the DB is unchanged if the migration transaction rolled back; otherwise restore the `pre-deploy` dump. |
| api unhealthy / restarting | `dc logs api`: settings validation (e.g. `API_BOOTSTRAP_SECRET`), provider config, embedding dimension mismatch (`EMBEDDING_DIMENSIONS` must equal the model's output size). `curl <URL>/api/health/ready` shows which dependency fails. |
| 400 `Invalid host header` | Add the public host name to `ALLOWED_HOSTS` (comma-separated) and redeploy. |
| 502 on `/api/*` | api container down or starting: `dc ps`, `dc logs api`. |
| Certificate not issued | DNS must resolve to this host, ports 80/443 open (`ufw status`, cloud firewall), `dc logs caddy | grep -i acme`; Let's Encrypt rate limits apply to repeated failures. |
| `/mcp` 404 / 502 / 401 | 404: `MCP_ROUTE` not `enabled`. 502: mcp not running (`--with-mcp`, `dc --profile mcp logs mcp`; exit code 2 = missing `MNEMOS_MCP_TOKEN`). 401: wrong/missing bearer token. |
| Experiences stay `pending` | Worker down or stalled: `dc ps worker`, `dc logs worker`; `/health/live` returns 503 `stalled` when the loop stops ticking; `dc restart worker`. Provider errors show as retried/dead-lettered jobs in the logs. |
| Smoke "port 5432 closed" fails | Something on the host listens on 5432/6379 (a host-installed Postgres/Redis, or an added `ports:` mapping). Remove it or run with `--skip-port-check` if intentional and firewalled. |
| Disk full | `docker system df`; `docker builder prune` and remove old release tags (`docker image rm mnemos/api:<old>`), keeping at least the previous release for rollback; check `BACKUP_KEEP_DAYS`; container logs are capped by rotation. |
| Restore verification fails on counts | The dump or manifest was altered/truncated - do not use it; take a new backup. Schema mismatch after an upgrade: `--allow-older-schema`. |

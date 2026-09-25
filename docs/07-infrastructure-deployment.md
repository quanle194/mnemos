# Infrastructure and Ubuntu VPS Deployment

## Target
Single private Ubuntu VPS first. Docker Compose production topology behind Caddy or Nginx with TLS. Services: reverse proxy, web, api, worker, postgres+pgvector, redis. Optional Ollama is a profile, not required.

## Containers
Pin image versions. Run application containers non-root where feasible. Healthchecks for API, web, postgres and redis. Persistent named volumes for Postgres and required proxy certificates. Restart policies enabled. Resource limits documented.

## Networking
Only 80/443 and SSH should be publicly exposed by default. PostgreSQL/Redis are internal Compose services, never host-published in production. API may be routed under `/api`; dashboard at root; MCP transport exposed only if explicitly secured/needed.

## Configuration
Provide `.env.example`, production validation, no committed secrets. Required variables include database URL/components, Redis URL, public URLs, API signing/key bootstrap secret, provider configuration, embedding dimensions/model, log level, CORS/allowed hosts.

## Deployment scripts
Provide `scripts/bootstrap-ubuntu.sh`, `scripts/deploy.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `scripts/smoke-prod.sh`. Scripts must be idempotent where reasonable and fail fast.

## Bootstrap
Install/verify Docker Engine + Compose plugin, firewall baseline, deploy user/directories, clone/pull repo, create env from documented template (without fabricating provider secrets), build/pull images, start DB/Redis, run migrations, start apps, health/smoke tests.

## TLS
Prefer Caddy for simple automatic HTTPS when a domain is provided. If no domain/certificate exists, deploy safely on HTTP bound according to documented operator choice; do not invent DNS. Super-agent must finish all deployable artifacts and clearly mark only truly external credentials/domain values as operator-supplied variables, not as blockers to implementation/testing.

## Backups
Nightly `pg_dump` or custom-format dump with retention policy; backup verification and restore drill script. Document volume snapshot option. Never call a backup complete until restore has been tested in an isolated database.

## Upgrade/rollback
Versioned images/releases; backup before migration; migration command; health check; rollback application image when schema-compatible. For destructive schema changes use expand/migrate/contract strategy.

## VPS acceptance
From a clean Ubuntu-compatible environment: bootstrap -> deploy -> migrate -> bootstrap workspace/key -> ingest experience -> process learning -> retrieve context -> open dashboard -> run smoke tests. Capture commands/results in `artifacts/deployment-report.md`.

# ADR 0007 - Single-VPS deployment topology

Status: accepted

## Decision
Docker Compose production stack: `caddy` (only service publishing ports 80/443) -> `web` (static dashboard via
unprivileged nginx) at `/` and `api` at `/api/*` (prefix stripped). Internal network only for `postgres`
(pgvector image) and `redis`. `migrate` is a one-shot service that must complete before `api`/`worker` start.
`mcp` (streamable HTTP) is an optional compose profile routed at `/mcp` only when enabled.
TLS: Caddy automatic HTTPS when `MNEMOS_DOMAIN` is set; otherwise `SITE_ADDRESS=:80` HTTP-only mode for private
networks/tunnels (documented operator choice). Images are pinned by tag; app containers run as non-root.
Backups: custom-format `pg_dump` with retention + mandatory isolated restore verification.

Local environment note: Docker Hub rate limits were hit in the build environment; the Docker daemon was pointed
at the `mirror.gcr.io` pull-through mirror. Image names in the repository remain canonical Docker Hub names.

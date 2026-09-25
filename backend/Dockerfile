# syntax=docker/dockerfile:1.7
#
# Mnemos Python image: API, worker, migrations, admin CLI and the optional MCP server.
# Build from the repository root (the uv workspace root):
#
#   docker build -f backend/Dockerfile -t mnemos/api:dev .
#
# Behind a TLS-intercepting proxy, pass its CA bundle as a BuildKit secret (never baked into the image):
#
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.pem -f backend/Dockerfile -t mnemos/api:dev .
#
# Runtime usage (ENTRYPOINT is the `mnemos` CLI):
#   docker run --rm mnemos/api:dev --help
#   docker run ... mnemos/api:dev migrate
#   docker run ... mnemos/api:dev api --host 0.0.0.0 --port 8000
#   docker run ... mnemos/api:dev worker
#   docker run --entrypoint mnemos-mcp ... mnemos/api:dev

ARG PYTHON_IMAGE=python:3.13-slim

# ---------------------------------------------------------------------------------------------- builder
FROM ${PYTHON_IMAGE} AS builder

ARG UV_VERSION=0.8.17
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PROJECT_ENVIRONMENT=/app/.venv

# uv is installed from PyPI (pinned) so the build only needs PyPI access.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install "uv==${UV_VERSION}"

WORKDIR /app

# 1) third-party dependencies only (cached layer; invalidated only by lockfile/pyproject changes)
COPY pyproject.toml uv.lock ./
COPY backend/pyproject.toml backend/pyproject.toml
COPY sdk/python/pyproject.toml sdk/python/pyproject.toml
COPY mcp-server/pyproject.toml mcp-server/pyproject.toml
COPY evals/pyproject.toml evals/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    uv sync --frozen --no-dev --all-packages --no-install-workspace

# 2) workspace packages (backend app + alembic, SDK, MCP server, evals). Installed editable on purpose:
#    the CLI resolves backend/alembic.ini relative to the `app` package, so the source tree stays at /app/backend.
COPY backend/ backend/
COPY sdk/python/ sdk/python/
COPY mcp-server/ mcp-server/
COPY evals/ evals/
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    uv sync --frozen --no-dev --all-packages \
    && python -m compileall -q -j 0 backend/app backend/alembic sdk/python mcp-server evals \
    && rm -f backend/Dockerfile

# ---------------------------------------------------------------------------------------------- runtime
FROM ${PYTHON_IMAGE} AS runtime

ARG VERSION=0.0.0-dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="mnemos" \
      org.opencontainers.image.description="Mnemos AI memory platform - API, worker, migrations, CLI and MCP server" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/mnemos/mnemos" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV PATH=/app/.venv/bin:${PATH} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONFAULTHANDLER=1 \
    MNEMOS_VERSION=${VERSION} \
    HEALTHCHECK_URL=http://127.0.0.1:8000/health/live

RUN groupadd --system --gid 10001 mnemos \
    && useradd --system --uid 10001 --gid mnemos --home-dir /app --no-create-home --shell /usr/sbin/nologin mnemos

WORKDIR /app

# Code and virtualenv are owned by root and read-only for the runtime user.
COPY --from=builder /app /app

# Dependency-free health probe (stdlib only, bypasses any HTTP proxy). Usage: mnemos-healthcheck [URL ...]
# Every URL (default: $HEALTHCHECK_URL) must answer HTTP 200 within 4s.
COPY --chmod=0755 <<'EOF' /usr/local/bin/mnemos-healthcheck
#!/usr/local/bin/python3
import os
import sys
import urllib.request

urls = sys.argv[1:] or [os.environ.get("HEALTHCHECK_URL", "http://127.0.0.1:8000/health/live")]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for url in urls:
    try:
        with opener.open(url, timeout=4) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
    except Exception as exc:  # noqa: BLE001
        print(f"unhealthy: {url}: {exc}", file=sys.stderr)
        sys.exit(1)
sys.exit(0)
EOF

USER 10001:10001

EXPOSE 8000 8001

HEALTHCHECK --interval=15s --timeout=6s --start-period=30s --retries=3 CMD ["mnemos-healthcheck"]

ENTRYPOINT ["mnemos"]
CMD ["api", "--host", "0.0.0.0", "--port", "8000"]

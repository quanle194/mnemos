# syntax=docker/dockerfile:1.7
#
# Mnemos dashboard: static Vite/React build served by unprivileged nginx on :8080.
# Build from the repository root:
#
#   docker build -f web/Dockerfile -t mnemos/web:dev .
#
# Behind a TLS-intercepting proxy, pass its CA bundle as a BuildKit secret (never baked into the image):
#
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.pem -f web/Dockerfile -t mnemos/web:dev .

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

# ---------------------------------------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build && test -f dist/index.html

# ---------------------------------------------------------------------------------------------- runtime
FROM ${NGINX_IMAGE} AS runtime

ARG VERSION=0.0.0-dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="mnemos-web" \
      org.opencontainers.image.description="Mnemos operations dashboard (static SPA on unprivileged nginx)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/mnemos/mnemos" \
      org.opencontainers.image.licenses="UNLICENSED"

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/web/dist /usr/share/nginx/html

# nginx-unprivileged already runs as uid 101; state it explicitly.
USER 101

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

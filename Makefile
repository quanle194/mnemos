# Mnemos task runner. `make help` lists targets.
SHELL := /bin/bash
.DEFAULT_GOAL := help
.ONESHELL:

UV            ?= uv
ENV_FILE      ?= .env
PROJECT       ?= mnemos
COMPOSE_PROD  := docker compose -p $(PROJECT) -f infra/docker-compose.prod.yml --env-file $(ENV_FILE)
COMPOSE_DEV   := docker compose -p $(PROJECT)-dev -f infra/docker-compose.dev.yml
TEST_PG_PORT  ?= 55432
TEST_REDIS_PORT ?= 56379
TEST_ENV      := MNEMOS_TEST_ADMIN_DSN=postgresql://mnemos:mnemos@127.0.0.1:$(TEST_PG_PORT)/postgres \
                 MNEMOS_TEST_REDIS_URL=redis://127.0.0.1:$(TEST_REDIS_PORT)/15
EVAL_URL      ?= http://localhost:18080/api
NODE_DIRS     := web sdk/typescript e2e

.PHONY: help setup dev dev-deps lint format typecheck test test-db test-db-down test-integration test-e2e eval \
        build up down migrate smoke backup backup-test logs ps clean openapi

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## Install all dependencies (Python uv workspace, web, TS SDK, E2E)
	$(UV) sync --all-packages --frozen
	for d in $(NODE_DIRS); do (cd $$d && npm ci --no-audit --no-fund) || exit 1; done

dev-deps: ## Start local Postgres(pgvector)+Redis for development
	$(COMPOSE_DEV) up -d postgres redis --wait

dev: dev-deps ## Run API, worker and dashboard dev server with hot reload (Ctrl+C to stop)
	set -a; [ -f $(ENV_FILE) ] && . ./$(ENV_FILE); set +a
	export DATABASE_URL=$${DEV_DATABASE_URL:-postgresql+asyncpg://mnemos:mnemos@127.0.0.1:$${DEV_PG_PORT:-5433}/mnemos}
	export REDIS_URL=$${DEV_REDIS_URL:-redis://127.0.0.1:$${DEV_REDIS_PORT:-6380}/0}
	$(UV) run mnemos migrate
	trap 'kill 0' EXIT
	$(UV) run mnemos api --reload & $(UV) run mnemos worker & (cd web && npm run dev) & wait

lint: ## Lint + format check (ruff, eslint, shellcheck)
	$(UV) run ruff check backend sdk/python mcp-server evals
	$(UV) run ruff format --check backend sdk/python mcp-server evals
	cd web && npm run lint
	cd sdk/typescript && npm run lint
	if command -v shellcheck >/dev/null; then shellcheck scripts/*.sh; else $(UV) run --with shellcheck-py shellcheck scripts/*.sh; fi

format: ## Auto-format Python code
	$(UV) run ruff check --fix backend sdk/python mcp-server evals
	$(UV) run ruff format backend sdk/python mcp-server evals

typecheck: ## Static type checks (mypy, tsc)
	$(UV) run mypy backend/app sdk/python/mnemos_sdk mcp-server/mnemos_mcp evals/mnemos_evals
	cd web && npm run typecheck
	cd sdk/typescript && npm run typecheck
	cd e2e && npm run typecheck

test: ## Unit tests (no infrastructure needed): backend unit, SDKs, MCP, dashboard
	$(UV) run pytest backend/tests/unit -q
	$(UV) run pytest sdk/python/tests -q
	$(UV) run pytest mcp-server/tests -q
	cd web && npm test
	cd sdk/typescript && npm test

test-db: ## Start disposable Postgres(pgvector)+Redis for integration tests
	docker inspect mnemos-test-pg >/dev/null 2>&1 || docker run -d --name mnemos-test-pg -e POSTGRES_USER=mnemos \
	  -e POSTGRES_PASSWORD=mnemos -e POSTGRES_DB=mnemos -p 127.0.0.1:$(TEST_PG_PORT):5432 pgvector/pgvector:0.8.0-pg16
	docker inspect mnemos-test-redis >/dev/null 2>&1 || docker run -d --name mnemos-test-redis \
	  -p 127.0.0.1:$(TEST_REDIS_PORT):6379 redis:7.4-alpine
	for i in $$(seq 1 60); do pg_isready -h 127.0.0.1 -p $(TEST_PG_PORT) -q 2>/dev/null && break; \
	  docker exec mnemos-test-pg pg_isready -U mnemos -q 2>/dev/null && break; sleep 1; done

test-db-down: ## Remove integration test containers
	docker rm -f mnemos-test-pg mnemos-test-redis >/dev/null 2>&1 || true

test-integration: ## Integration/API/worker tests against real Postgres+pgvector+Redis
	@if ! (echo > /dev/tcp/127.0.0.1/$(TEST_PG_PORT)) 2>/dev/null; then $(MAKE) test-db; fi
	$(TEST_ENV) $(UV) run pytest backend/tests/integration -q

test-e2e: ## Build + boot the production stack locally, run Playwright scenarios 1-10 + eval, tear down
	scripts/e2e.sh

eval: ## Run the Run-A -> learn -> Run-B learning eval against EVAL_URL (needs API_BOOTSTRAP_SECRET)
	$(UV) run mnemos-eval --url $(EVAL_URL) --secret "$${API_BOOTSTRAP_SECRET:?set API_BOOTSTRAP_SECRET}" \
	  --output artifacts/eval-report.json

build: ## Build production images, dashboard bundle and TS SDK
	cd web && npm run build
	cd sdk/typescript && npm run build
	$(COMPOSE_PROD) build

up: ## Start the production stack (uses $(ENV_FILE))
	$(COMPOSE_PROD) up -d --wait

down: ## Stop the production stack (volumes are kept)
	$(COMPOSE_PROD) down

migrate: ## Apply database migrations (production stack)
	$(COMPOSE_PROD) run --rm migrate

smoke: ## Production smoke test (ingest -> learn -> retrieve) against BASE_URL
	scripts/smoke-prod.sh

backup: ## Take a verified backup of the production database
	scripts/backup.sh

backup-test: ## Backup + isolated restore verification
	scripts/backup-test.sh

logs: ## Tail production logs
	$(COMPOSE_PROD) logs -f --tail=100

ps: ## Show production services
	$(COMPOSE_PROD) ps

openapi: ## Regenerate docs/openapi.json from the FastAPI app
	$(UV) run python -c "import json; from app.main import create_app; json.dump(create_app().openapi(), open('docs/openapi.json','w'), indent=1)"

clean: ## Remove build artifacts and caches
	rm -rf web/dist sdk/typescript/dist e2e/test-results e2e/playwright-report .pytest_cache .mypy_cache .ruff_cache

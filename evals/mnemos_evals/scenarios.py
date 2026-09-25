"""Deterministic task families with a hidden environment rule.

Each family has a naive action that fails with an informative error, and a fix that succeeds. Run A must
discover the fix by trial and error; Run B (a different agent/session, analogous task) can skip the failure only
if Mnemos retrieves the learned rule before acting.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Family:
    key: str
    project: str
    task_a: str
    task_b: str
    naive_action: str
    error: str
    diagnosis_steps: tuple[str, ...]
    fix_action: str
    success_result: str
    rule_keyword: str  # the knowledge the agent needs, detectable in retrieved context


FAMILIES: tuple[Family, ...] = (
    Family(
        key="deploy-migrations",
        project="platform",
        task_a="Deploy billing-api to staging",
        task_b="Deploy invoices-api to staging",
        naive_action="Ran database migrations with the default settings during deploy.",
        error="Deployment failed: migration timed out waiting for a lock on the orders table held by the nightly "
        "batch job.",
        diagnosis_steps=("inspect deploy logs", "query pg_locks", "check batch scheduler"),
        fix_action="Paused the nightly batch with batchctl pause, then ran migrations with --lock-timeout=5s.",
        success_result="Migrations applied and the deployment succeeded.",
        rule_keyword="--lock-timeout",
    ),
    Family(
        key="web-install",
        project="platform",
        task_a="Install dependencies for the admin dashboard web app",
        task_b="Install dependencies for the customer portal web app",
        naive_action="Ran npm install in the web app directory.",
        error="npm ERR! ERESOLVE could not resolve dependency tree: the repository lockfile is pnpm-lock.yaml.",
        diagnosis_steps=("read npm error log", "list lockfiles"),
        fix_action="Used pnpm install --frozen-lockfile because the repo uses pnpm workspaces.",
        success_result="Dependencies installed from the pnpm lockfile.",
        rule_keyword="pnpm install",
    ),
    Family(
        key="docker-build",
        project="platform",
        task_a="Build the docker image for the search-indexer service",
        task_b="Build the docker image for the email-sender service",
        naive_action="Ran docker build without any cache configuration.",
        error="Build failed: pip install timed out downloading wheels from the package index after 20 minutes.",
        diagnosis_steps=("inspect build output", "test index latency", "check buildkit settings"),
        fix_action="Enabled BuildKit and added a pip cache mount (RUN --mount=type=cache,target=/root/.cache/pip).",
        success_result="Image built in 2 minutes using the pip cache mount.",
        rule_keyword="cache mount",
    ),
    Family(
        key="partner-api-auth",
        project="integrations",
        task_a="Fetch invoices from the partner billing API",
        task_b="Fetch refunds from the partner billing API",
        naive_action="Called the partner billing API with basic auth credentials.",
        error="HTTP 401: partner billing API requires an HMAC-SHA256 request signature in the X-Signature header.",
        diagnosis_steps=("read API error body", "search partner docs"),
        fix_action="Signed each request with HMAC-SHA256 over the body and sent it in the X-Signature header.",
        success_result="Partner billing API returned 200 with the requested records.",
        rule_keyword="x-signature",
    ),
    Family(
        key="bulk-export",
        project="integrations",
        task_a="Export the full customers table to the data lake",
        task_b="Export the full orders table to the data lake",
        naive_action="Requested a single full-table export from the export API.",
        error="Gateway timeout: export requests longer than 60 seconds are aborted by the API gateway.",
        diagnosis_steps=("check gateway logs", "measure export duration"),
        fix_action="Exported in pages of 10000 rows using the cursor parameter of the export API.",
        success_result="All rows exported page by page without timeouts.",
        rule_keyword="cursor parameter",
    ),
)

# Knowledge seeded to measure false-memory and stale-memory use (must never be served in Run B).
FALSE_MEMORY = (
    "Deploys to staging never need database migrations; skip them to save time.",
    "Deploy api services to staging without migrations",
)
STALE_MEMORY = (
    "Dashboard dependencies are installed with yarn classic (yarn install).",
    "Install web app dependencies with yarn",
)

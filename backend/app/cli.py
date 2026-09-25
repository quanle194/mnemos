"""`mnemos` command line interface.

Local/admin commands talk to the database directly (migrate, admin bootstrap, worker, jobs drain).
Remote commands use the Python SDK against MNEMOS_URL with MNEMOS_API_KEY.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Annotated, Any

import typer

app = typer.Typer(help="Mnemos AI memory ecosystem CLI", no_args_is_help=True)
admin_app = typer.Typer(help="Administrative commands (direct DB access)", no_args_is_help=True)
memory_app = typer.Typer(help="Memory commands", no_args_is_help=True)
experience_app = typer.Typer(help="Experience commands", no_args_is_help=True)
dream_app = typer.Typer(help="Dream commands", no_args_is_help=True)
workspace_app = typer.Typer(help="Workspace commands", no_args_is_help=True)
jobs_app = typer.Typer(help="Job queue commands", no_args_is_help=True)
eval_app = typer.Typer(help="Evaluation commands", no_args_is_help=True)
for sub, name in (
    (admin_app, "admin"),
    (memory_app, "memory"),
    (experience_app, "experience"),
    (dream_app, "dream"),
    (workspace_app, "workspace"),
    (jobs_app, "jobs"),
    (eval_app, "eval"),
):
    app.add_typer(sub, name=name)

UrlOpt = Annotated[str, typer.Option(envvar="MNEMOS_URL", help="API base URL")]
KeyOpt = Annotated[str | None, typer.Option(envvar="MNEMOS_API_KEY", help="API key")]
WsOpt = Annotated[str, typer.Option(envvar="MNEMOS_WORKSPACE_ID", help="Workspace ID")]


def _print(data: Any) -> None:
    typer.echo(json.dumps(data, indent=2, default=str))


def _client(url: str, key: str | None):  # type: ignore[no-untyped-def]
    from mnemos_sdk import MnemosClient

    return MnemosClient(url, key)


# ------------------------------------------------------------------ servers
@app.command()
def api(host: str = "0.0.0.0", port: int = 8000, workers: int = 1, reload: bool = False) -> None:  # noqa: S104
    """Run the API server (uvicorn)."""
    import uvicorn

    uvicorn.run(
        "app.main:app_factory",
        factory=True,
        host=host,
        port=port,
        workers=workers,
        reload=reload,
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=False,
    )


@app.command()
def worker(health_port: int = typer.Option(8001, envvar="WORKER_HEALTH_PORT")) -> None:
    """Run the background worker (jobs + scheduler) with a health/metrics port."""
    from app.config import get_settings
    from app.container import Container
    from app.jobs.worker import run_worker
    from app.observability.logging import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json, "mnemos-worker")

    async def main() -> None:
        from app.observability.tracing import setup_tracing

        container = Container.build(settings)
        setup_tracing(settings, "mnemos-worker", engine=container.engine)
        try:
            await run_worker(container, health_port)
        finally:
            await container.aclose()

    asyncio.run(main())


def _alembic_config():  # type: ignore[no-untyped-def]
    from alembic.config import Config

    ini = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = Config(str(ini))
    cfg.attributes["configure_logger"] = False
    return cfg


@app.command()
def migrate(revision: str = "head", downgrade: bool = False) -> None:
    """Apply (or roll back) database migrations."""
    from alembic import command

    cfg = _alembic_config()
    if downgrade:
        command.downgrade(cfg, revision)
    else:
        command.upgrade(cfg, revision)
    typer.echo(f"migrations {'downgraded' if downgrade else 'applied'}: {revision}")


@app.command()
def health(url: UrlOpt = "http://localhost:8000") -> None:
    """Check API readiness."""
    with _client(url, None) as c:
        try:
            _print(c.health())
        except Exception as exc:
            typer.echo(f"unhealthy: {exc}", err=True)
            raise typer.Exit(1) from exc


# ------------------------------------------------------------------ admin (direct DB)
@admin_app.command("bootstrap")
def admin_bootstrap(
    organization: str = typer.Option(..., help="Organization name"),
    workspace: str = typer.Option("default", help="Initial workspace name"),
) -> None:
    """Create an organization, workspace and admin API key directly in the database."""
    from app.config import get_settings
    from app.container import Container
    from app.modules import tenancy_service

    async def main() -> dict[str, str]:
        container = Container.build(get_settings())
        try:
            async with container.sessions() as db:
                res = await tenancy_service.bootstrap(
                    db, container.settings, organization_name=organization, workspace_name=workspace
                )
                await db.commit()
                return {
                    "organization_id": str(res.organization.id),
                    "workspace_id": str(res.workspace.id),
                    "api_key": res.raw_key,
                }
        finally:
            await container.aclose()

    _print(asyncio.run(main()))


@admin_app.command("create-key")
def admin_create_key(
    organization_id: str,
    name: str,
    role: str = "agent",
    workspace_id: Annotated[list[str] | None, typer.Option()] = None,
) -> None:
    """Create an API key for an organization (direct DB)."""
    import uuid

    from app.config import get_settings
    from app.container import Container
    from app.domain.enums import Role
    from app.modules import tenancy_service
    from app.modules.ctx import Ctx
    from app.tenancy import Principal

    async def main() -> dict[str, str]:
        container = Container.build(get_settings())
        try:
            async with container.sessions() as db:
                ctx = Ctx(
                    db=db,
                    principal=Principal(
                        organization_id=uuid.UUID(organization_id),
                        role=Role.ADMIN,
                        actor_type="admin_cli",
                        actor_id="cli",
                    ),
                    container=container,
                )
                key, raw = await tenancy_service.create_api_key(
                    ctx, name=name, role=Role(role), workspace_ids=[uuid.UUID(w) for w in workspace_id or []] or None
                )
                await ctx.commit()
                return {"id": str(key.id), "role": key.role, "api_key": raw}
        finally:
            await container.aclose()

    _print(asyncio.run(main()))


# ------------------------------------------------------------------ jobs (direct DB)
@jobs_app.command("drain")
def jobs_drain(max_jobs: int = 10_000) -> None:
    """Synchronously process queued jobs until the queue is empty."""
    from app.config import get_settings
    from app.container import Container
    from app.jobs.worker import Worker

    async def main() -> int:
        container = Container.build(get_settings())
        try:
            return await Worker(container, "cli-drain").drain(max_jobs)
        finally:
            await container.aclose()

    typer.echo(f"processed {asyncio.run(main())} job(s)")


@jobs_app.command("schedule-once")
def jobs_schedule_once() -> None:
    """Run one scheduler tick (lifecycle sweep + dream triggers)."""
    from app.config import get_settings
    from app.container import Container
    from app.jobs.worker import Worker

    async def main() -> dict[str, int]:
        container = Container.build(get_settings())
        try:
            return await Worker(container, "cli-scheduler").schedule_once()
        finally:
            await container.aclose()

    _print(asyncio.run(main()))


# ------------------------------------------------------------------ remote commands (SDK)
@workspace_app.command("bootstrap")
def workspace_bootstrap(
    organization: str,
    workspace: str = "default",
    url: UrlOpt = "http://localhost:8000",
    secret: str = typer.Option(..., envvar="API_BOOTSTRAP_SECRET"),
) -> None:
    """Bootstrap organization/workspace/admin key through the API using the bootstrap secret."""
    with _client(url, None) as c:
        _print(c.bootstrap(secret, organization, workspace))


@workspace_app.command("list")
def workspace_list(url: UrlOpt = "http://localhost:8000", key: KeyOpt = None) -> None:
    with _client(url, key) as c:
        _print(c.request("GET", "/v1/workspaces"))


@memory_app.command("search")
def memory_search(
    query: str, workspace_id: WsOpt, url: UrlOpt = "http://localhost:8000", key: KeyOpt = None, limit: int = 10
) -> None:
    with _client(url, key) as c:
        res = c.search_memories(workspace_id, query, limit=limit)
        for item in res["items"]:
            m = item["memory"]
            typer.echo(f"{item['score']:.3f}  {m['id']}  [{m['type']}/{m['status']}]  {m['title']}")


@memory_app.command("show")
def memory_show(memory_id: str, url: UrlOpt = "http://localhost:8000", key: KeyOpt = None) -> None:
    with _client(url, key) as c:
        _print(
            {
                "memory": c.get_memory(memory_id),
                "evidence": c.memory_evidence(memory_id),
                "history": c.memory_history(memory_id),
                "relations": c.memory_relations(memory_id),
            }
        )


@app.command()
def context(
    query: str,
    workspace_id: WsOpt,
    url: UrlOpt = "http://localhost:8000",
    key: KeyOpt = None,
    token_budget: int = 2000,
    project_id: str | None = None,
    agent_id: str | None = None,
) -> None:
    """Build a token-budgeted context for a query."""
    with _client(url, key) as c:
        res = c.context(workspace_id, query, token_budget=token_budget, project_id=project_id, agent_id=agent_id)
        typer.echo(res["context"] or "(no relevant memories)")
        typer.echo(
            f"\n-- {len(res['memories'])} memories, ~{res['token_estimate']} tokens, trace {res['retrieval_trace_id']}",
            err=True,
        )


@experience_app.command("create")
def experience_create(
    workspace_id: WsOpt,
    task: str = typer.Option(...),
    outcome: str = typer.Option(...),
    observation: str = "",
    action: str = "",
    result: str = "",
    project: str | None = None,
    agent: str | None = None,
    wait: bool = False,
    url: UrlOpt = "http://localhost:8000",
    key: KeyOpt = None,
) -> None:
    with _client(url, key) as c:
        res = c.experience(
            workspace_id,
            task,
            outcome,
            observation=observation,
            action=action,
            result=result,
            project_name=project,
            agent_name=agent,
        )
        if wait:
            res = c.wait_for_learning(res["experience"]["id"])
        _print(res)


@dream_app.command("run")
def dream_run(mode: str, workspace_id: WsOpt, url: UrlOpt = "http://localhost:8000", key: KeyOpt = None) -> None:
    with _client(url, key) as c:
        _print(c.dream(workspace_id, mode))


@dream_app.command("status")
def dream_status(dream_id: str, url: UrlOpt = "http://localhost:8000", key: KeyOpt = None) -> None:
    with _client(url, key) as c:
        _print(c.get_dream(dream_id))


@eval_app.command("run")
def eval_run(
    url: UrlOpt = "http://localhost:8000",
    secret: str = typer.Option("change-me", envvar="API_BOOTSTRAP_SECRET"),
    output: str = "artifacts/eval-report.json",
) -> None:
    """Run the Run-A -> learn -> Run-B learning eval against a running stack."""
    try:
        from mnemos_evals.runner import run_eval
    except ImportError:
        typer.echo("mnemos-evals package is not installed", err=True)
        raise typer.Exit(2) from None
    report = run_eval(url, secret, output)
    typer.echo(json.dumps(report["summary"], indent=2))
    if not report["summary"].get("passed"):
        raise typer.Exit(1)


def main() -> None:
    sys.path.insert(0, os.getcwd())
    app()


if __name__ == "__main__":
    main()

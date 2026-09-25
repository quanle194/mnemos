"""Job dispatch. Every handler is idempotent (safe under at-least-once execution)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.container import Container
from app.db.models import Job, Organization
from app.jobs import queue
from app.modules import dreaming_service, learning_service, lifecycle_service
from app.modules.ctx import Ctx
from app.tenancy import Principal


async def dispatch(container: Container, job: Job) -> dict[str, Any]:
    async with container.sessions() as db:
        if job.kind == queue.LIFECYCLE_SWEEP and job.organization_id is None:
            orgs = (await db.scalars(select(Organization.id))).all()
            results = {}
            for org in orgs:
                ctx = Ctx(db=db, principal=Principal.system(org, "lifecycle"), container=container)
                results[str(org)] = await lifecycle_service.sweep(ctx)
                await ctx.commit()
            return {"organizations": results}
        assert job.organization_id is not None
        ctx = Ctx(db=db, principal=Principal.system(job.organization_id, f"worker:{job.kind}"), container=container)
        payload = job.payload_json
        match job.kind:
            case queue.EXTRACT_EXPERIENCE:
                result = await learning_service.process_experience(ctx, uuid.UUID(payload["experience_id"]))
            case queue.VALIDATE_CANDIDATE:
                result = await learning_service.validate_candidate(ctx, uuid.UUID(payload["memory_id"]))
            case queue.RUN_DREAM:
                result = await dreaming_service.run_dream(ctx, uuid.UUID(payload["dream_id"]))
            case queue.LIFECYCLE_SWEEP:
                result = await lifecycle_service.sweep(ctx)
            case _:
                raise ValueError(f"unknown job kind {job.kind}")
        await ctx.commit()
        return result

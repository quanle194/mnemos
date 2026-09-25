"""Idempotency-Key support for unsafe writes (replays the stored response for the same key+payload)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.errors import ApiError
from app.db.models import IdempotencyRecord
from app.modules.ctx import Ctx


def _hash(method: str, path: str, body: Any) -> str:
    raw = json.dumps(jsonable_encoder(body), sort_keys=True, default=str)
    return hashlib.sha256(f"{method}:{path}:{raw}".encode()).hexdigest()


async def run(
    ctx: Ctx,
    key: str | None,
    method: str,
    path: str,
    body: Any,
    status_code: int,
    handler: Callable[[], Awaitable[Any]],
) -> JSONResponse:
    """Execute handler once per (organization, key). Handler must NOT commit; this function commits."""
    if key is not None and not (1 <= len(key) <= 200):
        raise ApiError(422, "validation_error", "Idempotency-Key must be 1..200 characters")
    req_hash = _hash(method, path, body)
    if key:
        existing = await ctx.db.scalar(
            select(IdempotencyRecord).where(
                IdempotencyRecord.organization_id == ctx.principal.organization_id, IdempotencyRecord.key == key
            )
        )
        if existing:
            if existing.request_hash != req_hash:
                raise ApiError(409, "idempotency_key_reused", "Idempotency-Key was used with a different request")
            return JSONResponse(
                existing.response_json, status_code=existing.status_code, headers={"Idempotent-Replayed": "true"}
            )
    result = await handler()
    payload = jsonable_encoder(result)
    if key:
        ctx.db.add(
            IdempotencyRecord(
                organization_id=ctx.principal.organization_id,
                key=key,
                method=method,
                path=path,
                request_hash=req_hash,
                status_code=status_code,
                response_json=payload,
            )
        )
        try:
            await ctx.commit()
        except IntegrityError:
            # concurrent request with the same key won the race: return its stored response
            await ctx.db.rollback()
            existing = await ctx.db.scalar(
                select(IdempotencyRecord).where(
                    IdempotencyRecord.organization_id == ctx.principal.organization_id, IdempotencyRecord.key == key
                )
            )
            if existing is None or existing.request_hash != req_hash:
                raise ApiError(409, "idempotency_key_reused", "Idempotency-Key conflict") from None
            return JSONResponse(
                existing.response_json, status_code=existing.status_code, headers={"Idempotent-Replayed": "true"}
            )
    else:
        await ctx.commit()
    return JSONResponse(payload, status_code=status_code)

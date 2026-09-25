"""Structured JSON logging. Redaction runs as a processor *before* rendering."""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

import structlog

from app.domain.redaction import redact_value

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
job_id_var: ContextVar[str | None] = ContextVar("job_id", default=None)


def _add_context(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
    if (rid := request_id_var.get()) and "request_id" not in event:
        event["request_id"] = rid
    if (jid := job_id_var.get()) and "job_id" not in event:
        event["job_id"] = jid
    return event


def _redact(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
    return {k: (redact_value(v) if k != "timestamp" else v) for k, v in event.items()}


def configure_logging(level: str = "INFO", json_logs: bool = True, service: str = "mnemos") -> None:
    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _add_context,
        structlog.processors.format_exc_info,
        _redact,
    ]
    renderer: Any = structlog.processors.JSONRenderer() if json_logs else structlog.dev.ConsoleRenderer()
    structlog.configure(
        processors=[*processors, lambda _l, _m, e: {"service": service, **e}, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level.upper())),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    # route stdlib logging (uvicorn, sqlalchemy) through a plain handler at the same level
    logging.basicConfig(level=level.upper(), stream=sys.stdout, format="%(message)s")
    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).setLevel(logging.WARNING)

"""Optional OpenTelemetry tracing (enabled when OTEL_EXPORTER_OTLP_ENDPOINT is configured)."""

from __future__ import annotations

from typing import Any

import structlog

from app.config import Settings

log = structlog.get_logger(__name__)
_configured = False


def setup_tracing(settings: Settings, service: str, *, app: Any = None, engine: Any = None) -> bool:
    global _configured
    if not settings.otel_exporter_otlp_endpoint:
        return False
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    if not _configured:
        provider = TracerProvider(resource=Resource.create({"service.name": service}))
        endpoint = settings.otel_exporter_otlp_endpoint.rstrip("/") + "/v1/traces"
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(provider)
        _configured = True
    if app is not None:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="health/live,health/ready,metrics")
    if engine is not None:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        SQLAlchemyInstrumentor().instrument(engine=engine.sync_engine)
    log.info("tracing_enabled", endpoint=settings.otel_exporter_otlp_endpoint, service=service)
    return True


def current_trace_id() -> str | None:
    try:
        from opentelemetry import trace

        ctx = trace.get_current_span().get_span_context()
        return format(ctx.trace_id, "032x") if ctx.is_valid else None
    except Exception:
        return None

"""OpenTelemetry distributed tracing — gated on OTEL_EXPORTER_OTLP_ENDPOINT.

When OTEL_EXPORTER_OTLP_ENDPOINT is unset/empty the service behaves exactly as
before: no provider, no exporter, no spans, no startup change (so dev runs with
no collector stay clean). When set (e.g. ``http://otel-collector:4317``), spans
export over OTLP gRPC via a BatchSpanProcessor (background/non-blocking, so an
unreachable collector never blocks or crashes startup), and trace context flows
across services through W3C tracecontext HTTP headers.

``setup_tracing`` below is service-specific (it wires FastAPI/SQLAlchemy/httpx/
asyncpg instrumentation against auth-svc's own ``db.py`` engine and
``logging_config`` logger), so it stays here. ``inject_headers``,
``extract_context`` and ``shutdown_tracing`` have no such coupling and are
byte-identical across every service that uses them — see the shared
``tracing`` package (``services/shared/tracing/tracing.py``) and import them
from there, e.g. ``from tracing import inject_headers``.
"""
from __future__ import annotations

import os

from .logging_config import log

SERVICE_NAME = "auth-svc"


def setup_tracing(app=None) -> None:
    """Initialize tracing iff OTEL_EXPORTER_OTLP_ENDPOINT is configured.

    No-op (returns immediately) when the endpoint env var is unset/empty.
    Pass the FastAPI ``app`` to also instrument inbound HTTP requests.
    """
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.propagate import set_global_textmap
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.trace.propagation.tracecontext import (
        TraceContextTextMapPropagator,
    )

    provider = TracerProvider(resource=Resource.create({"service.name": SERVICE_NAME}))
    # Batch/background export: an unreachable collector can never block startup
    # or request handling — spans are buffered and flushed off the hot path.
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=True))
    )
    trace.set_tracer_provider(provider)

    # W3C tracecontext so trace context propagates across services via HTTP headers.
    set_global_textmap(TraceContextTextMapPropagator())

    # Instrument defensively: a missing/incompatible optional instrumentor must
    # never crash startup. Each is isolated so one failure doesn't skip the rest.
    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app)
        except Exception as exc:  # noqa: BLE001 - tracing must not break startup
            log.warning("otel_instrument_failed", target="fastapi", error=str(exc))

    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        # SQLAlchemyInstrumentor needs the sync engine behind the async one.
        from .db import engine

        SQLAlchemyInstrumentor().instrument(engine=engine.sync_engine)
    except Exception as exc:  # noqa: BLE001
        log.warning("otel_instrument_failed", target="sqlalchemy", error=str(exc))

    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
    except Exception as exc:  # noqa: BLE001
        log.warning("otel_instrument_failed", target="httpx", error=str(exc))

    try:
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor

        AsyncPGInstrumentor().instrument()
    except Exception as exc:  # noqa: BLE001
        log.warning("otel_instrument_failed", target="asyncpg", error=str(exc))

    # NOTE: aiokafka auto-instrumentation is intentionally NOT wired — the
    # opentelemetry-instrumentation-aiokafka 0.50b0 wrapper is incompatible with
    # aiokafka 0.12's send() signature (passes `headers` twice -> TypeError on
    # every produce). Kafka producer/consumer spans + W3C traceparent
    # propagation are instead done manually (see app/events/poller.py and the
    # shared tracing package's inject_headers helper).

    log.info("otel_tracing_enabled", service=SERVICE_NAME, endpoint=endpoint)

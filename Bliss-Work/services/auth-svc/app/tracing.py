"""OpenTelemetry distributed tracing — gated on OTEL_EXPORTER_OTLP_ENDPOINT.

When OTEL_EXPORTER_OTLP_ENDPOINT is unset/empty the service behaves exactly as
before: no provider, no exporter, no spans, no startup change (so dev runs with
no collector stay clean). When set (e.g. ``http://otel-collector:4317``), spans
export over OTLP gRPC via a BatchSpanProcessor (background/non-blocking, so an
unreachable collector never blocks or crashes startup), and trace context flows
across services through W3C tracecontext HTTP headers.
"""
from __future__ import annotations

import os

from .logging_config import log

SERVICE_NAME = "auth-svc"

# W3C trace-context header keys we propagate over Kafka. Lowercase to match the
# propagator's output and keep consumer-side lookups case-stable.
_TRACE_HEADER_KEYS = ("traceparent", "tracestate")


def inject_headers(headers=None):
    """Inject the current trace context as W3C Kafka headers.

    Returns a list of ``(key: str, value: bytes)`` tuples for aiokafka
    ``send(..., headers=...)``; any caller-supplied ``headers`` are preserved
    and the trace headers appended. No-op-safe when tracing is disabled (the
    global propagator emits nothing without an active span).
    """
    from opentelemetry import propagate

    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    result = list(headers) if headers else []
    for key in _TRACE_HEADER_KEYS:
        value = carrier.get(key)
        if value is not None:
            result.append((key, value.encode("utf-8")))
    return result


def extract_context(headers):
    """Extract a trace context from aiokafka message headers.

    ``headers`` is ``msg.headers`` — a list of ``(key: str, value: bytes)``
    tuples (may be None). Returns an OpenTelemetry context to pass to
    ``tracer.start_as_current_span(context=...)``. No-op-safe when disabled.
    """
    from opentelemetry import propagate

    carrier: dict[str, str] = {}
    for key, value in headers or []:
        if key in _TRACE_HEADER_KEYS and value is not None:
            carrier[key] = value.decode("utf-8") if isinstance(value, bytes) else str(value)
    return propagate.extract(carrier)


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
    # inject_headers/extract_context helpers above).

    log.info("otel_tracing_enabled", service=SERVICE_NAME, endpoint=endpoint)


def shutdown_tracing() -> None:
    """Flush buffered spans on service stop. No-op when tracing is disabled."""
    from opentelemetry import trace

    provider = trace.get_tracer_provider()
    # The default (no-op) provider has no shutdown(); only the SDK provider we
    # installed when the endpoint was set does. Guard so this is safe either way.
    shutdown = getattr(provider, "shutdown", None)
    if callable(shutdown):
        try:
            shutdown()
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            log.warning("otel_shutdown_failed", error=str(exc))

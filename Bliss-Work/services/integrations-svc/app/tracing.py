from __future__ import annotations

import os

from .logging_setup import log

_SERVICE_NAME = "task-svc"

# W3C trace-context header keys we propagate over Kafka. Kept lowercase to match
# what the propagator emits and so consumer-side lookups are case-stable.
_TRACE_HEADER_KEYS = ("traceparent", "tracestate")


def inject_headers(headers=None):
    """Inject the current trace context as W3C Kafka headers.

    Returns a list of ``(key: str, value: bytes)`` tuples suitable for
    aiokafka ``send(..., headers=...)``. Any caller-supplied ``headers`` are
    preserved and the trace headers appended. When tracing is disabled the
    global propagator is a no-op TraceContext propagator with no active span,
    so this simply returns the input unchanged (cheap + harmless).
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


def setup_tracing(app=None) -> None:
    """Wire OpenTelemetry distributed tracing — gated on configuration.

    No-ops entirely unless OTEL_EXPORTER_OTLP_ENDPOINT is set and non-empty, so
    a dev run with no collector behaves EXACTLY as before (no exporter, no
    spans, no startup change). When enabled, exports spans over OTLP/gRPC via a
    BatchSpanProcessor (background/non-blocking), so an unreachable collector
    can never block or crash startup. Sets the W3C tracecontext propagator so
    trace context flows across services through HTTP headers.

    Imports are deferred into this function so the OpenTelemetry packages are
    only required when tracing is actually turned on.
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

    provider = TracerProvider(resource=Resource.create({"service.name": _SERVICE_NAME}))
    # insecure=True: plaintext gRPC to the in-cluster collector (no TLS).
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=True))
    )
    trace.set_tracer_provider(provider)
    set_global_textmap(TraceContextTextMapPropagator())

    # Each instrumentation is wrapped independently: a missing optional
    # instrumentor (or one that can't bind yet) must never crash startup.
    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app)
        except Exception:  # noqa: BLE001 — tracing must never break the app
            log.exception("tracing_instrument_failed", target="fastapi")

    # SQLAlchemy: instrument the sync engine underlying the async engine. The
    # engine is created lazily, so this no-ops cleanly if it isn't ready yet.
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        from .db import get_engine

        engine = get_engine()
        sync_engine = getattr(engine, "sync_engine", None)
        if sync_engine is not None:
            SQLAlchemyInstrumentor().instrument(engine=sync_engine)
    except Exception:  # noqa: BLE001
        log.exception("tracing_instrument_failed", target="sqlalchemy")

    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
    except Exception:  # noqa: BLE001
        log.exception("tracing_instrument_failed", target="httpx")

    try:
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor

        AsyncPGInstrumentor().instrument()
    except Exception:  # noqa: BLE001
        log.exception("tracing_instrument_failed", target="asyncpg")

    # NOTE: aiokafka instrumentation is intentionally NOT wired. The
    # opentelemetry-instrumentation-aiokafka 0.50b0 wrapper is incompatible with
    # aiokafka 0.12's send() signature (it passes `headers` twice -> TypeError on
    # every produce), which broke the outbox publisher entirely. The HTTP + DB
    # spans above still give end-to-end cross-service traces; add Kafka spans back
    # only with a fixed instrumentor version (or via manual spans).

    log.info("tracing_enabled", service=_SERVICE_NAME, endpoint=endpoint)

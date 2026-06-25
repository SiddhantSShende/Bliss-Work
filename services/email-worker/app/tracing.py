"""OpenTelemetry distributed tracing for email-worker — gated on configuration.

email-worker is a pure Kafka consumer (no FastAPI, no SQLAlchemy); it talks to
asyncpg (emaildb), httpx (auth-svc internal API) and aiokafka, so only those
instrumentors are wired here.
"""
from __future__ import annotations

import os

from .logging_setup import get_logger

_log = get_logger("tracing")

_SERVICE_NAME = "email-worker"

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
    ``tracer.start_as_current_span(context=...)`` so the consumer span
    continues the producer's trace. No-op-safe when tracing is disabled.
    """
    from opentelemetry import propagate

    carrier: dict[str, str] = {}
    for key, value in headers or []:
        if key in _TRACE_HEADER_KEYS and value is not None:
            carrier[key] = value.decode("utf-8") if isinstance(value, bytes) else str(value)
    return propagate.extract(carrier)


def setup_tracing(app=None) -> None:
    """Wire OpenTelemetry distributed tracing — gated on configuration.

    No-ops entirely unless OTEL_EXPORTER_OTLP_ENDPOINT is set and non-empty, so
    a dev run with no collector behaves EXACTLY as before (no exporter, no
    spans, no startup change). When enabled, exports spans over OTLP/gRPC via a
    BatchSpanProcessor (background/non-blocking), so an unreachable collector
    can never block or crash startup. Sets the W3C tracecontext propagator so
    trace context flows across services through HTTP headers.

    ``app`` is accepted for signature parity with the FastAPI services but is
    unused here — email-worker has no web app.

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
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
    except Exception:  # noqa: BLE001 — tracing must never break the worker
        _log.exception("tracing_instrument_failed", target="httpx")

    try:
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor

        AsyncPGInstrumentor().instrument()
    except Exception:  # noqa: BLE001
        _log.exception("tracing_instrument_failed", target="asyncpg")

    # NOTE: aiokafka instrumentation is intentionally NOT wired — the
    # opentelemetry-instrumentation-aiokafka 0.50b0 wrapper is incompatible with
    # aiokafka 0.12's send() signature (passes `headers` twice -> TypeError on
    # every produce). httpx + asyncpg spans above still trace the worker's
    # outbound calls; add Kafka spans back only with a fixed instrumentor version.

    _log.info("tracing_enabled", service=_SERVICE_NAME, endpoint=endpoint)

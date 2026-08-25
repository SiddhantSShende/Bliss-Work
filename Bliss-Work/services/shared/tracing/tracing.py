"""OpenTelemetry context-propagation + shutdown helpers, shared across services.

These three are pure and parameter-free — no service name, no logger import, no
database engine — so unlike each service's own ``app/tracing.py`` (which wires
FastAPI/SQLAlchemy/httpx/asyncpg instrumentation against that service's own
``db.py`` and ``logging_setup.py`` shapes, and stays duplicated per-service for
that reason) these three are genuinely identical everywhere and were
byte-for-byte copies before this package existed:

  * ``inject_headers`` — producer side: stamp the current trace context onto
    outgoing Kafka message headers.
  * ``extract_context`` — consumer side: recover a trace context from an
    inbound Kafka message's headers, to continue the producer's trace.
  * ``shutdown_tracing`` — flush buffered spans on graceful shutdown. Safe to
    call whether or not tracing was ever configured.

All three are no-op-safe when tracing is disabled (OTEL_EXPORTER_OTLP_ENDPOINT
unset): the global propagator/provider are OpenTelemetry's own no-op
implementations in that case.
"""
from __future__ import annotations

# W3C trace-context header keys propagated over Kafka. Lowercase to match the
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

    ``headers`` is the ``msg.headers`` list of ``(key: str, value: bytes)``
    tuples (may be None). Returns an OpenTelemetry context that can be passed
    to ``tracer.start_as_current_span(context=...)`` so the consumer span
    continues the producer's trace. No-op-safe when tracing is disabled.
    """
    from opentelemetry import propagate

    carrier: dict[str, str] = {}
    for key, value in headers or []:
        if key in _TRACE_HEADER_KEYS and value is not None:
            carrier[key] = value.decode("utf-8") if isinstance(value, bytes) else str(value)
    return propagate.extract(carrier)


def shutdown_tracing(log=None) -> None:
    """Flush buffered spans on service stop. No-op when tracing is disabled.

    ``log`` is any object with a ``warning(event, **kwargs)`` method (e.g. a
    structlog logger); pass the caller's own logger so a flush failure is
    reported through that service's normal logging. Omit it to swallow a
    flush failure silently rather than raise during shutdown.
    """
    from opentelemetry import trace

    provider = trace.get_tracer_provider()
    # The default (no-op) provider has no shutdown(); only the SDK provider
    # installed when tracing was configured does. Guard so this is safe either way.
    shutdown = getattr(provider, "shutdown", None)
    if callable(shutdown):
        try:
            shutdown()
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            if log is not None:
                log.warning("otel_shutdown_failed", error=str(exc))

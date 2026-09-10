"""Tests for ``tracing``: the Kafka context-propagation and shutdown helpers.

No-op safety matters as much as the happy path here: every one of these is
called on every produce/consume/shutdown regardless of whether
OTEL_EXPORTER_OTLP_ENDPOINT is set, so a crash on malformed/absent input would
take down message publishing/consumption/shutdown for every service, all the
time, rather than only when tracing is on.

OpenTelemetry's global TracerProvider can be set only ONCE per process (a
second ``set_tracer_provider`` call is silently ignored with a warning), so a
real SDK provider is installed once, module-scoped, rather than per test.
"""
from __future__ import annotations

import pytest
from opentelemetry import propagate, trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from tracing import extract_context, inject_headers, shutdown_tracing


@pytest.fixture(scope="module", autouse=True)
def _real_provider():
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(InMemorySpanExporter()))
    trace.set_tracer_provider(provider)
    propagate.set_global_textmap(TraceContextTextMapPropagator())
    return provider


def test_inject_headers_preserves_caller_supplied_headers():
    existing = [("x-caller-header", b"keep-me")]
    result = inject_headers(existing)
    assert ("x-caller-header", b"keep-me") in result


def test_inject_headers_defaults_to_a_list_with_no_caller_headers():
    assert isinstance(inject_headers(), list)


def test_inject_headers_with_no_active_span_adds_nothing_extra():
    # Outside any span, the propagator has no active context to inject, so
    # only the caller's own headers come back.
    assert inject_headers([("x-caller-header", b"v")]) == [("x-caller-header", b"v")]


def test_extract_context_handles_none_and_empty_headers():
    # Must not raise — a message with no headers (or a non-traced producer) is
    # the common case, not an error case.
    assert extract_context(None) is not None
    assert extract_context([]) is not None


def test_extract_context_ignores_unrelated_headers():
    ctx = extract_context([("x-unrelated", b"value")])
    assert ctx is not None


def test_shutdown_tracing_does_not_raise_on_the_configured_provider():
    shutdown_tracing()
    shutdown_tracing(log=None)


class _RecordingLog:
    def __init__(self):
        self.warnings: list[tuple[str, dict]] = []

    def warning(self, event, **kwargs):
        self.warnings.append((event, kwargs))


def test_shutdown_tracing_reports_failure_via_the_caller_supplied_log(monkeypatch):
    class _BrokenProvider:
        def shutdown(self):
            raise RuntimeError("collector unreachable")

    # Patch what shutdown_tracing() actually calls, rather than the real
    # global provider (which can only be set once per process — see module
    # docstring).
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: _BrokenProvider())

    log = _RecordingLog()
    shutdown_tracing(log=log)  # must not raise
    assert log.warnings == [("otel_shutdown_failed", {"error": "collector unreachable"})]


def test_shutdown_tracing_swallows_failure_silently_without_a_log(monkeypatch):
    class _BrokenProvider:
        def shutdown(self):
            raise RuntimeError("collector unreachable")

    monkeypatch.setattr(trace, "get_tracer_provider", lambda: _BrokenProvider())
    shutdown_tracing()  # no log supplied — must still not raise


def test_inject_then_extract_round_trip_recovers_the_same_trace():
    """The actual point of both functions: a producer's trace_id must survive
    the Kafka hop and be recoverable by the consumer's extract_context."""
    tracer = trace.get_tracer(__name__)
    with tracer.start_as_current_span("produce") as span:
        expected_trace_id = span.get_span_context().trace_id
        headers = inject_headers()

    ctx = extract_context(headers)
    with tracer.start_as_current_span("consume", context=ctx) as consumer_span:
        assert consumer_span.get_span_context().trace_id == expected_trace_id

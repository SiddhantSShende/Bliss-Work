"""Parsing for the OTLP/HTTP JSON logs export format, scoped to exactly the
subset routes/otlp_bridge.py needs.

Deliberately NOT a general OTLP SDK or a full `opentelemetry-proto` message
implementation — this repo has no protobuf dependency for OTLP today (see
requirements.txt; telemetry-svc only pulls the exporter side, for its own
tracing), and adding one to receive a handful of well-known fields would be
more machinery than the job needs. What is implemented is exactly the shape
the Collector's `otlphttp` exporter produces with `encoding: json` (see
infra/observability/otel-collector.yaml's otlphttp/activity exporter) for the
OTLP Logs data model: `ExportLogsServiceRequest.resourceLogs[].scopeLogs[]
.logRecords[]`, JSON-encoded per the OTLP spec (camelCase, fixed64 fields as
strings). Reference: opentelemetry-proto v1's logs.proto.

This module has NO opinion about BlissWork's activity model — it only turns
OTLP JSON into plain Python values (a timestamp, a resource attribute dict, a
log body as a dict). Turning THAT into an ActivityRow is otlp_bridge.py's job,
which is where the unified model (ingest.py's ActivityRow) is actually reused.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

# Mirrors AgentBatch.events' cap (schemas.py, max_length=200) — an OTLP
# export is just another batched producer, and a collector that gathered
# more than 200 log records before flushing is treated the same as an agent
# posting more than 200 events in a single call (see schemas.py's comment:
# "a hostile or buggy agent must not be able to turn this into free
# storage"). Not imported from schemas.py: that module's DTOs are a REST
# concern, and this one deliberately has no opinion about BlissWork's
# activity model (see module docstring) — the two are kept in sync by this
# comment, the same way otlp_bridge.py's _AGENT_CATEGORIES already mirrors
# routes/agent.py's by comment rather than import.
MAX_LOG_RECORDS = 200


@dataclass
class ParsedLogRecord:
    """One `logRecords[]` entry, with its parent resource's attributes
    attached — OTLP nests resource once per `resourceLogs[]` group and shares
    it across every log record under it, but a caller processing records one
    at a time wants both together."""

    occurred_at: datetime
    resource_attributes: dict[str, str]
    body: dict[str, Any]


def _any_value_to_python(value: dict[str, Any] | None) -> Any:
    """OTLP's AnyValue is a tagged union: exactly one of stringValue,
    intValue/boolValue/doubleValue, or a nested kvlistValue/arrayValue is
    present. Recurses for the two container variants; every other case is
    values already storable as-is."""
    if not value:
        return None
    if "stringValue" in value:
        return value["stringValue"]
    if "intValue" in value:
        # OTLP JSON encodes int64 as a numeric STRING (precision safety across
        # JS/JSON number limits) — this repo's own durationMs etc. are plain
        # ints, so this converts back rather than propagating the string.
        try:
            return int(value["intValue"])
        except (TypeError, ValueError):
            return None
    if "boolValue" in value:
        return value["boolValue"]
    if "doubleValue" in value:
        return value["doubleValue"]
    if "kvlistValue" in value:
        return _kvlist_to_dict(value["kvlistValue"].get("values", []))
    if "arrayValue" in value:
        return [_any_value_to_python(v) for v in value["arrayValue"].get("values", [])]
    return None


def _kvlist_to_dict(kv_pairs: list[dict[str, Any]]) -> dict[str, Any]:
    """A KeyValue[] (used for both `resource.attributes` and any
    `kvlistValue`-typed AnyValue) as a plain dict. Last key wins on a
    duplicate — OTLP does not define a stricter merge rule, and neither does
    anything downstream of this that reads the result."""
    out: dict[str, Any] = {}
    for kv in kv_pairs:
        key = kv.get("key")
        if not isinstance(key, str) or not key:
            continue
        out[key] = _any_value_to_python(kv.get("value"))
    return out


def _parse_time_unix_nano(raw: Any) -> datetime | None:
    """`timeUnixNano` is a fixed64 encoded as a JSON string (see the module
    docstring). Falls back to None — never "now" — so a caller can decide
    what an absent/malformed timestamp should mean, the same way
    clamp_occurred_at already treats an absent BeaconEvent.occurredAt."""
    if raw is None:
        return None
    try:
        nanos = int(raw)
    except (TypeError, ValueError):
        return None
    if nanos <= 0:
        return None
    return datetime.fromtimestamp(nanos / 1_000_000_000, tz=timezone.utc)


def parse_export_logs_request(payload: dict[str, Any]) -> list[ParsedLogRecord]:
    """Flatten `ExportLogsServiceRequest` JSON into one list of records.

    Malformed entries are skipped individually rather than failing the whole
    batch — the same posture insert_events already takes toward a batch that
    partially fails (a savepoint undoes only the failed statement), applied
    here one level earlier: one bad log record must not cost the other 199
    good ones in the same export.

    Raises `ValueError` if the export carries more than `MAX_LOG_RECORDS`
    `logRecords[]` entries in total (summed across every resourceLogs /
    scopeLogs group, so a producer cannot evade the cap by splitting a huge
    batch across several groups in one request) — rejected outright rather
    than truncated, the same "reject, don't silently drop the tail" contract
    AgentBatch/Beacon already get for free from Pydantic's `max_length`.
    Checked before any record is parsed: counting logRecords[] lengths is
    cheap, and there is no reason to spend work turning AnyValue/kvlist trees
    into Python for an export this bridge is about to reject anyway.
    """
    resource_logs_groups = payload.get("resourceLogs") or []
    total_records = sum(
        len(scope_logs.get("logRecords") or [])
        for resource_logs in resource_logs_groups
        for scope_logs in resource_logs.get("scopeLogs") or []
    )
    if total_records > MAX_LOG_RECORDS:
        raise ValueError(f"export exceeds {MAX_LOG_RECORDS} log records (got {total_records})")

    out: list[ParsedLogRecord] = []
    for resource_logs in resource_logs_groups:
        resource = resource_logs.get("resource") or {}
        resource_attrs = _kvlist_to_dict(resource.get("attributes") or [])
        for scope_logs in resource_logs.get("scopeLogs") or []:
            for record in scope_logs.get("logRecords") or []:
                occurred_at = _parse_time_unix_nano(record.get("timeUnixNano"))
                if occurred_at is None:
                    # observedTimeUnixNano is a documented OTLP fallback for
                    # exactly this case — a record whose own event time was
                    # not set falls back to when the SDK observed it, which is
                    # still a real timestamp rather than "now" chosen here.
                    occurred_at = _parse_time_unix_nano(record.get("observedTimeUnixNano"))
                if occurred_at is None:
                    continue
                body = _any_value_to_python(record.get("body"))
                if not isinstance(body, dict):
                    continue
                out.append(
                    ParsedLogRecord(
                        occurred_at=occurred_at,
                        resource_attributes={k: str(v) for k, v in resource_attrs.items() if v is not None},
                        body=body,
                    )
                )
    return out

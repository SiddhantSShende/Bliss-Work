"""Parsing OTLP/HTTP JSON logs export bodies — pure logic, no database, no
HTTP. Fixtures are shaped exactly like what the collector's otlphttp exporter
actually sends with `encoding: json` (see otel-collector.yaml).
"""
from __future__ import annotations

import pytest

otlp_logs = pytest.importorskip(
    "app.otlp_logs", reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)


def _kv(key: str, **value) -> dict:
    """One OTLP KeyValue. `value` is a single kwarg naming the AnyValue
    variant, e.g. _kv("action", stringValue="app.focus")."""
    return {"key": key, "value": value}


def _export_request(*, resource_attrs: list[dict], records: list[dict]) -> dict:
    return {
        "resourceLogs": [{
            "resource": {"attributes": resource_attrs},
            "scopeLogs": [{"logRecords": records}],
        }]
    }


def test_parses_a_well_formed_record_end_to_end():
    payload = _export_request(
        resource_attrs=[
            _kv("blisswork.signal", stringValue="activity"),
            _kv("blisswork.source", stringValue="desktop"),
        ],
        records=[{
            "timeUnixNano": "1786633200000000000",  # 2026-08-13T15:00:00Z
            "body": {
                "kvlistValue": {"values": [
                    _kv("action", stringValue="app.focus"),
                    _kv("category", stringValue="app"),
                    _kv("targetKind", stringValue="app"),
                    _kv("targetId", stringValue="Google Chrome"),
                    _kv("durationMs", intValue="840000"),
                ]}
            },
        }],
    )
    records = otlp_logs.parse_export_logs_request(payload)
    assert len(records) == 1
    r = records[0]
    assert r.occurred_at.isoformat() == "2026-08-13T15:00:00+00:00"
    assert r.resource_attributes == {"blisswork.signal": "activity", "blisswork.source": "desktop"}
    assert r.body == {
        "action": "app.focus", "category": "app", "targetKind": "app",
        "targetId": "Google Chrome", "durationMs": 840000,
    }


def test_nested_detail_kvlist_round_trips_as_a_dict():
    payload = _export_request(
        resource_attrs=[],
        records=[{
            "timeUnixNano": "1786633200000000000",
            "body": {
                "kvlistValue": {"values": [
                    _kv("action", stringValue="site.visit"),
                    _kv("detail", kvlistValue={"values": [
                        _kv("title", stringValue="Learn Go in 30 Minutes"),
                        _kv("url", stringValue="youtube.com/watch?v=ABC"),
                    ]}),
                ]}
            },
        }],
    )
    records = otlp_logs.parse_export_logs_request(payload)
    assert records[0].body["detail"] == {
        "title": "Learn Go in 30 Minutes", "url": "youtube.com/watch?v=ABC",
    }


def test_falls_back_to_observed_time_when_event_time_is_absent():
    payload = _export_request(
        resource_attrs=[],
        records=[{
            "timeUnixNano": "0",
            "observedTimeUnixNano": "1786633200000000000",
            "body": {"kvlistValue": {"values": [_kv("action", stringValue="x")]}},
        }],
    )
    records = otlp_logs.parse_export_logs_request(payload)
    assert len(records) == 1
    assert records[0].occurred_at.isoformat() == "2026-08-13T15:00:00+00:00"


def test_a_record_with_no_usable_timestamp_at_all_is_dropped():
    payload = _export_request(
        resource_attrs=[],
        records=[{"body": {"kvlistValue": {"values": [_kv("action", stringValue="x")]}}}],
    )
    assert otlp_logs.parse_export_logs_request(payload) == []


def test_a_record_whose_body_is_not_a_kvlist_is_dropped():
    """A stringValue body (a plain log line, not a structured event) has no
    fields this bridge can turn into an ActivityRow — dropped, not crashed."""
    payload = _export_request(
        resource_attrs=[],
        records=[{
            "timeUnixNano": "1786633200000000000",
            "body": {"stringValue": "just a plain log line"},
        }],
    )
    assert otlp_logs.parse_export_logs_request(payload) == []


def test_one_bad_record_does_not_cost_the_others_in_the_same_export():
    payload = _export_request(
        resource_attrs=[],
        records=[
            {"body": {"kvlistValue": {"values": [_kv("action", stringValue="no-timestamp")]}}},
            {
                "timeUnixNano": "1786633200000000000",
                "body": {"kvlistValue": {"values": [_kv("action", stringValue="good")]}},
            },
        ],
    )
    records = otlp_logs.parse_export_logs_request(payload)
    assert len(records) == 1
    assert records[0].body["action"] == "good"


def test_multiple_resource_groups_and_multiple_records_each():
    """Two separate ResourceLogs groups (two producers exported in the SAME
    batch, plausible once the collector is batching across sources) each keep
    their OWN resource attributes rather than one leaking into the other."""
    payload = {
        "resourceLogs": [
            {
                "resource": {"attributes": [_kv("blisswork.source", stringValue="desktop")]},
                "scopeLogs": [{"logRecords": [
                    {"timeUnixNano": "1786633200000000000",
                     "body": {"kvlistValue": {"values": [_kv("action", stringValue="app.focus")]}}},
                ]}],
            },
            {
                "resource": {"attributes": [_kv("blisswork.source", stringValue="extension")]},
                "scopeLogs": [{"logRecords": [
                    {"timeUnixNano": "1786633200000000000",
                     "body": {"kvlistValue": {"values": [_kv("action", stringValue="site.visit")]}}},
                ]}],
            },
        ]
    }
    records = otlp_logs.parse_export_logs_request(payload)
    assert len(records) == 2
    assert records[0].resource_attributes["blisswork.source"] == "desktop"
    assert records[1].resource_attributes["blisswork.source"] == "extension"


def test_an_empty_export_request_parses_to_an_empty_list():
    assert otlp_logs.parse_export_logs_request({}) == []
    assert otlp_logs.parse_export_logs_request({"resourceLogs": []}) == []


def test_array_value_recurses_into_a_python_list():
    payload = _export_request(
        resource_attrs=[],
        records=[{
            "timeUnixNano": "1786633200000000000",
            "body": {"kvlistValue": {"values": [
                _kv("action", stringValue="x"),
                _kv("tags", arrayValue={"values": [{"stringValue": "a"}, {"stringValue": "b"}]}),
            ]}},
        }],
    )
    records = otlp_logs.parse_export_logs_request(payload)
    assert records[0].body["tags"] == ["a", "b"]

"""B-TEL-2: a beacon's free-form `detail` is bounded.

`detail: dict[str, str]` had no size limit of its own, so one request could carry
~1 MiB of arbitrary text per event into the encrypted detail column (120
requests/minute, kept 90 days), despite the schema's comment promising it was
"bounded hard".
"""
from __future__ import annotations

import pytest

pytest.importorskip("pydantic")
from pydantic import ValidationError  # noqa: E402

from app import schemas  # noqa: E402
from app.schemas import Beacon, BeaconEvent  # noqa: E402


def _event(detail):
    return BeaconEvent(action="attachment.opened", detail=detail)


def test_what_real_clients_send_is_accepted():
    # useAttachmentActivity.ts / ScreenshotNotice.tsx — the largest detail payloads in the client.
    _event({"filename": "f" * 255, "channel": "0" * 36})
    _event({"chord": "Cmd+Shift+4", "context": "Chat with Jane", "route": "/app/chat/123",
            "contextId": "0" * 36, "contextName": "Jane Okafor"})
    _event(None)
    _event({})


def test_too_many_keys_is_rejected():
    with pytest.raises(ValidationError):
        _event({f"k{i}": "v" for i in range(schemas.DETAIL_MAX_KEYS + 1)})
    _event({f"k{i}": "v" for i in range(schemas.DETAIL_MAX_KEYS)})


def test_an_oversized_key_is_rejected():
    with pytest.raises(ValidationError):
        _event({"k" * (schemas.DETAIL_MAX_KEY_CHARS + 1): "v"})


def test_an_oversized_value_is_rejected():
    with pytest.raises(ValidationError):
        _event({"note": "x" * (schemas.DETAIL_MAX_VALUE_CHARS + 1)})
    _event({"note": "x" * schemas.DETAIL_MAX_VALUE_CHARS})


def test_the_per_event_total_is_enforced_in_utf8_bytes_not_characters():
    # 4 values x 1000 characters is under every per-field cap, but 4 bytes per character is not.
    with pytest.raises(ValidationError):
        _event({f"k{i}": "\U0001f600" * 1000 for i in range(4)})
    # Many in-cap ASCII fields still add up to over the event budget.
    with pytest.raises(ValidationError):
        _event({f"k{i}": "x" * 1000 for i in range(5)})


def test_the_batch_total_is_bounded_even_when_every_event_is_within_its_own_cap():
    per_event = {"a": "x" * 1000, "b": "x" * 1000}  # ~2 KB: fine alone
    n_ok = schemas.DETAIL_MAX_BATCH_BYTES // 2002
    Beacon(events=[BeaconEvent(action="a", detail=per_event) for _ in range(n_ok)])
    with pytest.raises(ValidationError):
        Beacon(events=[BeaconEvent(action="a", detail=per_event) for _ in range(n_ok + 2)])


def test_a_batch_of_events_without_detail_is_unaffected():
    Beacon(events=[BeaconEvent(action="route.open") for _ in range(100)])

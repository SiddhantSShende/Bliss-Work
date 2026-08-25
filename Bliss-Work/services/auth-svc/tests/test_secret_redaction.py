"""The outbox poller must never publish a raw single-use secret to Kafka.

Pure-logic test of ``_redact_for_publish`` — password-reset / email-verify /
invite payloads get their raw URL stripped and an `outboxId` added before
publish, so email-worker can pull the secret back via an authenticated
internal call instead. Every other event type (and any non-dict payload)
passes through completely unchanged. See
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 3.
"""
from __future__ import annotations

import pytest

poller = pytest.importorskip(
    "app.events.poller",
    reason="auth-svc deps (aiokafka) not installed locally; CI installs requirements.txt.",
)


@pytest.mark.parametrize(
    "event_type,secret_field",
    [
        ("password.reset.requested", "resetUrl"),
        ("email.verification.requested", "verifyUrl"),
        ("invite.created", "inviteUrl"),
    ],
)
def test_secret_event_types_are_redacted(event_type, secret_field):
    payload = {
        "eventId": "evt-1",
        "type": event_type,
        "userId": "u1",
        secret_field: "https://app.test/x?token=SUPER-SECRET",
        "expiresAt": "2026-01-01T00:00:00.000Z",
    }

    redacted = poller._redact_for_publish("outbox-row-1", payload)

    assert secret_field not in redacted
    assert redacted["outboxId"] == "outbox-row-1"
    # Everything else the event carried survives.
    assert redacted["userId"] == "u1"
    assert redacted["type"] == event_type
    assert redacted["expiresAt"] == payload["expiresAt"]
    # The original row's own payload is never mutated in place.
    assert secret_field in payload


def test_unrelated_event_types_pass_through_unchanged():
    payload = {"eventId": "evt-2", "type": "user.created", "userId": "u1"}

    result = poller._redact_for_publish("outbox-row-2", payload)

    assert result is payload  # untouched, not even copied


def test_non_dict_payload_passes_through_unchanged():
    result = poller._redact_for_publish("outbox-row-3", "not-a-dict")

    assert result == "not-a-dict"


def test_missing_type_key_passes_through_unchanged():
    payload = {"eventId": "evt-4"}  # malformed, but must not crash the poller

    result = poller._redact_for_publish("outbox-row-4", payload)

    assert result is payload

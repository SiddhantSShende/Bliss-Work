"""B-EW-4: the relay's DLQ record carries identifiers, never content.

`_to_dlq` stripped a short deny-list of mail.outbound fields and forwarded the
rest. The list missed `envelope`, `cc`, `subject`, `fromName` and `attachments`,
and did nothing for message.created (`body`) or task.assigned (`title`,
`description`) — chat text, task text and real addresses went to a no-ACL topic
in clear. It is now an allow-list, so a field nobody thought of is dropped by
default.

Drives the REAL _to_dlq; only the Kafka producer is a stand-in.
"""
from __future__ import annotations

import json

import pytest

from tests.test_provider_transport import _consumer

SECRETS = (
    "ultra-private chat text",
    "Quarterly layoffs plan",
    "task description with details",
    "victim@private.example",
    "cc-person@outside.example",
    "Salary negotiation subject",
    "Jane Okafor",
    "jane@acme.example",
    "secret-attachment.pdf",
    "bcc-hidden@outside.example",
)


class _Producer:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_and_wait(self, _topic, value, headers=None):
        self.sent.append(json.loads(value))


def _consumer_with_producer():
    c, _m, _t = _consumer()
    c._producer = _Producer()  # noqa: SLF001
    c._settings.dlq_topic = "email-worker-dlq"  # noqa: SLF001
    return c, c._producer  # noqa: SLF001


EVENTS = {
    "message.created": {
        "type": "message.created", "eventId": "evt-m", "orgId": "org-1",
        "occurredAt": "2026-10-07T10:00:00Z", "conversationId": "conv-1",
        "messageId": "msg-1", "senderId": "u-sender", "recipientId": "u-recipient",
        "body": "ultra-private chat text", "senderDisplayName": "Jane Okafor",
    },
    "task.assigned": {
        "type": "task.assigned", "eventId": "evt-t", "orgId": "org-1",
        "taskId": "task-1", "assigneeId": "u-assignee", "senderId": "u-sender",
        "senderUsername": "Jane Okafor", "title": "Quarterly layoffs plan",
        "description": "task description with details",
    },
    "mail.outbound": {
        "type": "mail.outbound", "eventId": "evt-o", "orgId": "org-1", "mailId": "mail-1",
        "authorId": "u-author", "envelope": "victim@private.example",
        "to": ["victim@private.example"], "cc": ["cc-person@outside.example"],
        "subject": "Salary negotiation subject", "bodyText": "ultra-private chat text",
        "bodyHtml": "<p>ultra-private chat text</p>", "fromName": "Jane Okafor",
        "fromAddress": "jane@acme.example", "providerCopy": True,
        "providerTo": ["victim@private.example"], "providerBcc": ["bcc-hidden@outside.example"],
        "attachments": [{"id": "a1", "filename": "secret-attachment.pdf", "sizeBytes": 10}],
    },
}


@pytest.mark.asyncio
@pytest.mark.parametrize("etype", sorted(EVENTS))
async def test_no_content_or_address_reaches_the_dlq(etype):
    c, producer = _consumer_with_producer()

    await c._to_dlq(EVENTS[etype], "smtp down")  # noqa: SLF001

    (record,) = producer.sent
    blob = json.dumps(record)
    for secret in SECRETS:
        assert secret not in blob, f"{secret!r} leaked into the DLQ record for {etype}"


@pytest.mark.asyncio
@pytest.mark.parametrize("etype", sorted(EVENTS))
async def test_the_record_still_identifies_the_event(etype):
    c, producer = _consumer_with_producer()
    event = EVENTS[etype]

    await c._to_dlq(event, "smtp down")  # noqa: SLF001

    (record,) = producer.sent
    assert record["source"] == "relay" and record["reason"] == "smtp down"
    kept = record["event"]
    for key in ("eventId", "type", "orgId"):
        assert kept[key] == event[key]
    for key in ("mailId", "messageId", "taskId", "recipientId", "assigneeId", "senderId", "authorId"):
        if key in event:
            assert kept[key] == event[key]


@pytest.mark.asyncio
async def test_the_outbound_recipient_is_correlatable_by_hash_only():
    c, producer = _consumer_with_producer()
    a = dict(EVENTS["mail.outbound"], envelope="Victim@Private.example ")
    b = dict(EVENTS["mail.outbound"], envelope="victim@private.example", eventId="evt-o2")

    await c._to_dlq(a, "x")  # noqa: SLF001
    await c._to_dlq(b, "x")  # noqa: SLF001

    h1, h2 = (r["event"]["envelopeHash"] for r in producer.sent)
    assert h1 == h2 and len(h1) == 16 and "private" not in h1


@pytest.mark.asyncio
async def test_a_nested_value_under_an_allow_listed_name_is_not_forwarded():
    c, producer = _consumer_with_producer()

    await c._to_dlq({"eventId": "e", "type": "mail.outbound", "orgId": {"body": "ultra-private chat text"}}, "x")  # noqa: SLF001

    assert "ultra-private chat text" not in json.dumps(producer.sent[0])


@pytest.mark.asyncio
async def test_an_address_quoted_in_the_failure_reason_is_redacted_and_the_reason_bounded():
    c, producer = _consumer_with_producer()
    reason = "550 5.1.1 <victim@private.example>: Recipient address rejected " + "x" * 1000

    await c._to_dlq(EVENTS["mail.outbound"], reason)  # noqa: SLF001

    recorded = producer.sent[0]["reason"]
    assert "victim@private.example" not in recorded and "<email>" in recorded
    assert len(recorded) <= 300

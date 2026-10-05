"""Kafka domain event → activity row.

The preview cases are the ones that matter most. Message bodies ride the Kafka
event in the clear and use the structured-payload encoding from
packages/app/src/lib/chatEnvelope.ts:

    "{readable prefix}" + U+001F + JSON.stringify(envelope)

Everything after the separator is machine payload — attachment ids, shared GPS
coordinates. It must never reach the telemetry store, and "we split on the right
character" is exactly the kind of thing that silently stops being true when
someone reformats the encoding.
"""
from __future__ import annotations

import uuid

import pytest

consumer = pytest.importorskip(
    "app.consumer",
    reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)
event_map = pytest.importorskip("app.event_map")

to_row = consumer.to_activity_row
SENTINEL = event_map.ENVELOPE_SENTINEL

ORG = str(uuid.uuid4())
ALICE = str(uuid.uuid4())
BOB = str(uuid.uuid4())


def _evt(**kw):
    base = {"eventId": str(uuid.uuid4()), "orgId": ORG,
            "occurredAt": "2026-08-13T09:00:00.000Z"}
    base.update(kw)
    return base


def test_message_is_attributed_to_the_sender():
    row = to_row(_evt(type="message.created", senderId=ALICE, recipientId=BOB,
                      conversationId="c1", body="hello"))
    assert row.user_id == ALICE
    assert row.action == "message.sent"
    assert row.surface == "chats"
    assert row.target_id == "c1"
    assert row.source == "server"


def test_media_preview_keeps_only_the_readable_prefix():
    body = f"🖼️ 3 photos{SENTINEL}" + '{"media":[{"id":"att_secret"}]}'
    row = to_row(_evt(type="message.created", senderId=ALICE, conversationId="c1", body=body))
    assert row.detail["preview"] == "🖼️ 3 photos"
    assert "att_secret" not in str(row.detail)


def test_location_coordinates_never_reach_telemetry():
    body = f"📍 Shared a location{SENTINEL}" + '{"lat":51.5074,"lng":-0.1278}'
    row = to_row(_evt(type="message.created", senderId=ALICE, conversationId="c1", body=body))
    assert row.detail["preview"] == "📍 Shared a location"
    assert "51.5" not in str(row.detail)


def test_preview_is_truncated():
    row = to_row(_evt(type="message.created", senderId=ALICE, conversationId="c1",
                      body="x" * 500))
    assert len(row.detail["preview"]) <= event_map.PREVIEW_MAX_CHARS


def test_empty_body_produces_no_preview():
    row = to_row(_evt(type="message.created", senderId=ALICE, conversationId="c1", body=""))
    assert row.detail == {}


def test_task_transitions_are_attributed_to_the_assignee():
    row = to_row(_evt(type="task.completed", assigneeId=BOB, senderId=ALICE, taskId="t1"))
    assert row.user_id == BOB
    assert row.action == "task.completed"


def test_allocation_is_attributed_to_the_allocator():
    # The one task event where the actor is NOT the assignee: somebody else
    # performed it, and crediting the assignee would put work on their timeline
    # they did not do.
    row = to_row(_evt(type="task.assigned", assigneeId=BOB, senderId=ALICE, taskId="t1"))
    assert row.user_id == ALICE
    assert row.action == "task.allocated"


@pytest.mark.parametrize(
    "event",
    [
        # No human actor — a consequence, not an act.
        {"type": "notification.created", "recipientId": ALICE},
        # Automatic side effects of the UI (scrolling, a socket connecting).
        {"type": "message.read", "readerId": ALICE},
        {"type": "message.delivered", "senderId": ALICE},
        # Membership admin lives in auth-svc's hash-chained audit log instead.
        {"type": "user.role_changed", "userId": ALICE},
        {"type": "user.created", "userId": ALICE},
    ],
)
def test_unmapped_events_are_ignored(event):
    assert to_row(_evt(**event)) is None


def test_missing_actor_is_ignored():
    assert to_row(_evt(type="message.created", conversationId="c1", body="hi")) is None


def test_missing_org_is_ignored():
    e = _evt(type="message.created", senderId=ALICE, conversationId="c1", body="hi")
    del e["orgId"]
    assert to_row(e) is None


def test_garbage_is_ignored():
    assert to_row(None) is None
    assert to_row("not a dict") is None
    assert to_row({}) is None


def test_ids_are_bounded():
    row = to_row(_evt(type="message.created", senderId=ALICE, conversationId="c" * 5000,
                      body="hi"))
    assert len(row.target_id) <= 128


# ── mail.attachment.downloaded ────────────────────────────────────────────────
# Emitted by messaging-svc when a reader explicitly starts a download of a mail's
# file. The field names below are the ones store.RecordMailAttachmentDownload
# writes (events.MailAttachmentDownloaded); mail_attachment_download_db_test.go
# pins them on the Go side.
ATT = str(uuid.uuid4())
MAIL = str(uuid.uuid4())


def _download(**kw):
    base = dict(type="mail.attachment.downloaded", actorId=BOB, mailId=MAIL, attachmentId=ATT,
                filename="Q3 deck.pdf", mime="application/pdf", sizeBytes=4096)
    base.update(kw)
    return _evt(**base)


def test_mail_attachment_download_is_an_engagement_row_on_the_mail_surface():
    row = to_row(_download())
    assert row.user_id == BOB
    assert row.org_id == ORG
    assert row.category == "engagement"
    assert row.action == "mail.attachment.downloaded"
    assert row.surface == "mail"
    assert row.target_kind == "attachment"
    assert row.target_id == ATT
    assert row.source == "server"


def test_mail_attachment_download_keeps_filename_and_metadata_in_detail():
    row = to_row(_download())
    assert row.detail == {
        "filename": "Q3 deck.pdf",
        "mime": "application/pdf",
        "sizeBytes": "4096",
        "mailId": MAIL,
    }
    # The timeline contract is dict[str, str]; an int would break the read model.
    assert all(isinstance(v, str) for v in row.detail.values())
    assert "preview" not in row.detail


def test_mail_attachment_download_is_attributed_to_the_actor_not_the_sender():
    # senderId (the mail's author) is not a field of this event; even if some
    # producer added one, the actor is the person who pressed Download.
    row = to_row(_download(senderId=ALICE))
    assert row.user_id == BOB


def test_mail_attachment_download_without_an_actor_is_skipped():
    assert to_row(_download(actorId=None)) is None
    assert to_row(_download(actorId="")) is None
    evt = _download()
    del evt["actorId"]
    assert to_row(evt) is None


def test_mail_attachment_download_detail_is_bounded_and_scalar_only():
    row = to_row(_download(filename="x" * 5000, mime=["application/pdf"], sizeBytes=True))
    assert len(row.detail["filename"]) == event_map.DETAIL_VALUE_MAX_CHARS
    assert "mime" not in row.detail, "a list is not a fact this mapping can store"
    assert "sizeBytes" not in row.detail, "a bool is not a size"


def test_mail_attachment_download_with_no_filename_still_records_the_download():
    row = to_row(_download(filename=""))
    assert row is not None
    assert "filename" not in row.detail
    assert row.target_id == ATT


def test_other_events_gain_no_detail_from_the_new_field_list():
    # detail_fields is per-mapping: a chat message must not pick up filename/mime.
    row = to_row(_evt(type="message.created", senderId=ALICE, conversationId="c1", body="hi",
                      filename="leak.pdf", mime="application/pdf"))
    assert row.detail == {"preview": "hi"}

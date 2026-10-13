"""Files attached to a mail, from the event that names them to the MIME part.

The bytes never ride the Kafka event — the broker's default message cap is 1 MB
and a mail to five external addresses would carry five copies — so the event
carries metadata and this worker fetches each file from messaging-svc, which is
the service the blob volume is mounted into.

Two properties matter more than the plumbing and are pinned hardest below:

  * the budget is spent against DECLARED sizes, before anything is downloaded.
    An upload may be 100 MB; Gmail refuses at 25 and base64 adds a third. A file
    that cannot be delivered must not be fetched and encoded first.
  * a file that cannot be had never costs the message. Retrying the mail to
    recover one attachment means nobody receives the words either, so a failed
    fetch is reported to the recipient and the mail goes out regardless.
"""
from __future__ import annotations

import json
import types

import aiosmtplib
import httpx
import pytest

from app import relay_consumer
from app.attachments import Attachment, fetch, within_budget
from app.mailer import Mailer, safe_filename
from app.relay_consumer import RelayConsumer

MB = 1024 * 1024


def _att(name: str, size: int, mime: str = "application/pdf") -> Attachment:
    return Attachment(id=f"id-{name}", filename=name, mime=mime, size_bytes=size)


# ── the budget, which is pure arithmetic on metadata ─────────────────────────


def test_everything_fits_under_the_budget():
    files = [_att("a.pdf", 1 * MB), _att("b.pdf", 2 * MB)]

    fits, skipped = within_budget(files, 10 * MB)

    assert [f.filename for f in fits] == ["a.pdf", "b.pdf"]
    assert skipped == []


def test_one_oversized_file_does_not_suppress_the_ones_behind_it():
    # A 90 MB video attached first must not cost the 40 KB agenda attached
    # second — which is what a "stop at the first that does not fit" loop does.
    files = [_att("video.mp4", 90 * MB), _att("agenda.pdf", 40 * 1024)]

    fits, skipped = within_budget(files, 10 * MB)

    assert [f.filename for f in fits] == ["agenda.pdf"]
    assert [f.filename for f in skipped] == ["video.mp4"]


def test_the_budget_is_a_total_not_a_per_file_limit():
    files = [_att("a.pdf", 6 * MB), _att("b.pdf", 6 * MB)]

    fits, skipped = within_budget(files, 10 * MB)

    assert [f.filename for f in fits] == ["a.pdf"]
    assert [f.filename for f in skipped] == ["b.pdf"]


def test_a_zero_budget_relays_no_files_at_all():
    # A deployment's way of saying "this SMTP route does not carry attachments".
    fits, skipped = within_budget([_att("a.pdf", 1)], 0)

    assert fits == []
    assert [f.filename for f in skipped] == ["a.pdf"]


def test_an_unknown_declared_size_is_let_through_without_spending_the_budget():
    # size_bytes=None (from_event could not trust what the event declared) must
    # not be treated as free, but it also must not be dropped over metadata
    # alone — and it must not eat into what is left for files declared after
    # it, since its real cost is still unknown at this point.
    known = _att("known.pdf", 6 * MB)
    unknown = Attachment(id="id-x", filename="x.pdf", mime="application/pdf", size_bytes=None)

    fits, skipped = within_budget([unknown, known], 10 * MB)

    assert [f.filename for f in fits] == ["x.pdf", "known.pdf"]
    assert skipped == []


async def test_fetch_uses_the_mail_budget_as_the_ceiling_when_size_is_unknown():
    # Before this fix, an unknown declared size fell back to a ceiling of
    # ~4KB (0 + _SIZE_SLACK), so a real, well-within-budget file was aborted
    # mid-transfer and reported to the recipient as missing. The ceiling for an
    # unknown size must be the actual per-mail budget, not a slack margin
    # around a phantom zero.
    body = b"x" * (500 * 1024)  # 500KB — nowhere near the 10MB budget

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    att = Attachment(id="a1", filename="deck.pdf", mime="application/pdf", size_bytes=None)

    data = await fetch(
        client,
        base_url="http://messaging-svc:8004",
        token="test-token",
        org_id="018f0000-0000-7000-8000-0000000000cc",
        mail_id="018f0000-0000-7000-8000-0000000000aa",
        attachment=Attachment(
            id="018f0000-0000-7000-8000-0000000000bb",
            filename=att.filename,
            mime=att.mime,
            size_bytes=att.size_bytes,
        ),
        budget_bytes=10 * MB,
    )

    assert data == body


async def test_malformed_attachment_ids_never_receive_internal_credentials():
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"file")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    valid = "018f0000-0000-7000-8000-0000000000aa"
    invalid = Attachment(
        id="../admin", filename="x.pdf", mime="application/pdf", size_bytes=4
    )

    result = await fetch(
        client,
        base_url="http://messaging-svc:8004",
        token="internal-secret",
        org_id=valid,
        mail_id=valid,
        attachment=invalid,
        budget_bytes=10 * MB,
    )

    assert result is None
    assert requests == []


async def test_valid_attachment_ids_construct_the_expected_internal_path():
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"file")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    org_id = "018f0000-0000-7000-8000-0000000000cc"
    mail_id = "018f0000-0000-7000-8000-0000000000aa"
    attachment_id = "018f0000-0000-7000-8000-0000000000bb"

    result = await fetch(
        client,
        base_url="http://messaging-svc:8004",
        token="internal-secret",
        org_id=org_id,
        mail_id=mail_id,
        attachment=Attachment(
            id=attachment_id, filename="x.pdf", mime="application/pdf", size_bytes=4
        ),
        budget_bytes=10 * MB,
    )

    assert result == b"file"
    assert requests[0].url.path.endswith(
        f"/internal/mail/{mail_id}/attachments/{attachment_id}"
    )
    assert requests[0].headers["X-Internal-Token"] == "internal-secret"


# ── event parsing, which reads whatever crossed the topic ────────────────────


def test_an_entry_with_no_id_names_no_file():
    assert Attachment.from_event({"filename": "a.pdf"}) is None
    assert Attachment.from_event("not-a-dict") is None


def test_a_missing_or_absurd_size_is_unknown_not_a_free_zero():
    # Collapsing this to size_bytes=0 used to make within_budget treat the file
    # as costing nothing, while fetch()'s ceiling was built from that same
    # phantom 0 — dropping a real, well-within-budget file after ~4KB. None is
    # what lets the two sides agree on "unknown" instead of disagreeing on 0.
    assert Attachment.from_event({"id": "x", "sizeBytes": "huge"}).size_bytes is None
    assert Attachment.from_event({"id": "x", "sizeBytes": -5}).size_bytes is None
    assert Attachment.from_event({"id": "x"}).size_bytes is None


def test_an_unnamed_file_still_gets_a_name():
    # A part with no filename is shown by clients as "noname" or hidden entirely.
    att = Attachment.from_event({"id": "x"})
    assert att.filename == "attachment"
    assert att.mime == "application/octet-stream"


# ── the MIME the mailer builds ───────────────────────────────────────────────


@pytest.fixture()
def outbox(monkeypatch) -> list:
    sent: list = []

    async def _capture(message, **kwargs):
        sent.append(message)

    monkeypatch.setattr(aiosmtplib, "send", _capture)
    return sent


async def _send_with(attachments, outbox) -> object:
    await Mailer("mailpit", 1025, "no-reply@blisswork.test").send(
        to="partner@outside.test", subject="Q3 numbers",
        text_body="Deck attached.", html_body="<p>Deck attached.</p>",
        from_name="Jane Okafor", from_address="jane@acme.test",
        attachments=attachments,
    )
    return outbox[0]


async def test_the_file_rides_as_an_attachment_part(outbox):
    msg = await _send_with([("q3.pdf", "application/pdf", b"%PDF-1.4")], outbox)

    parts = list(msg.iter_attachments())
    assert len(parts) == 1
    assert parts[0].get_filename() == "q3.pdf"
    assert parts[0].get_content_type() == "application/pdf"
    assert parts[0].get_payload(decode=True) == b"%PDF-1.4"


async def test_the_body_is_still_the_body(outbox):
    # Adding a part turns multipart/alternative into multipart/mixed. If the
    # nesting were wrong the text would arrive as a mystery attachment, or the
    # attachment would replace the message.
    msg = await _send_with([("q3.pdf", "application/pdf", b"%PDF-1.4")], outbox)

    assert msg.get_content_type() == "multipart/mixed"
    assert msg.get_body(preferencelist=("html",)).get_content_type() == "text/html"
    assert "Deck attached." in msg.get_body(preferencelist=("plain",)).get_content()


async def test_a_mail_with_no_files_is_shaped_exactly_as_before(outbox):
    msg = await _send_with(None, outbox)

    assert msg.get_content_type() == "multipart/alternative"
    assert list(msg.iter_attachments()) == []


async def test_an_unusable_mime_becomes_octet_stream(outbox):
    # add_attachment raises on a maintype it cannot split, which would fail the
    # send. octet-stream is what every client falls back to anyway.
    msg = await _send_with([("weird", "not-a-mime", b"\x00\x01")], outbox)

    assert list(msg.iter_attachments())[0].get_content_type() == "application/octet-stream"


async def test_a_unicode_filename_survives_the_header(outbox):
    msg = await _send_with([("café ünicode.pdf", "application/pdf", b"x")], outbox)

    assert list(msg.iter_attachments())[0].get_filename() == "café ünicode.pdf"


async def test_a_filename_cannot_inject_a_header(outbox):
    # Python's policy REFUSES CR/LF in a header value — by raising, which here
    # would fail the send, retry it, and eventually DLQ the whole message over a
    # bad character in a filename. Cleaned instead: the mail arrives, no header
    # is forged, and the file keeps a usable name.
    msg = await _send_with(
        [("ok.pdf\r\nBcc: attacker@evil.test", "application/pdf", b"x")], outbox
    )

    assert msg["Bcc"] is None
    assert not any(line.startswith("Bcc:") for line in msg.as_string().splitlines())


def test_safe_filename_never_returns_nothing():
    # A part with an empty filename is hidden by some clients entirely.
    assert safe_filename("") == "attachment"
    assert safe_filename("\r\n\x00") == "attachment"


def test_safe_filename_neutralises_path_separators():
    # Some clients honour a path on extraction.
    assert safe_filename("../../etc/passwd") == ".._.._etc_passwd"


# ── the relay, where a fetch can fail ────────────────────────────────────────


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@blisswork.test",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", poison_max_failures=3,
        messaging_internal_base="http://messaging-svc:8004",
        messaging_internal_token="test-token",
        mail_attachment_budget_bytes=10 * MB,
        relay_max_concurrency=4,
    )


class _RecordingMailer:
    def __init__(self) -> None:
        self.sends: list[dict] = []

    async def send(self, **kwargs: object) -> None:
        self.sends.append(dict(kwargs))


def _consumer(monkeypatch, fetched: dict[str, bytes | None], budget: int = 10 * MB):
    """A relay whose only stubbed edges are the dedup claim and the file fetch.

    The fetch is replaced through monkeypatch rather than by assigning the module
    global: this module and test_outbound_mail.py drive the same coroutine, and a
    stub that outlived its test would silently answer the other file's sends.
    """
    settings = _settings()
    settings.mail_attachment_budget_bytes = budget
    c = RelayConsumer(settings)
    mailer = _RecordingMailer()
    c._mailer = mailer  # noqa: SLF001
    c._http = object()  # noqa: SLF001 - only ever handed to the stub below

    async def _claim(*_a: str) -> bool:
        return True

    async def _mark_sent(*_a: str) -> None:
        return None

    async def _fetch(_client, *, attachment, **_kw):
        return fetched.get(attachment.id)

    c._claim = _claim          # noqa: SLF001
    c._mark_sent = _mark_sent  # noqa: SLF001
    monkeypatch.setattr(relay_consumer, "fetch_attachment", _fetch)
    return c, mailer


def _event(attachments: list[dict]) -> bytes:
    return json.dumps({
        "type": "mail.outbound",
        "eventId": "018f0000-0000-7000-8000-0000000000bb",
        "orgId": "018f0000-0000-7000-8000-0000000000cc",
        "occurredAt": "2026-08-18T09:00:00.000Z",
        "mailId": "018f0000-0000-7000-8000-0000000000aa",
        "envelope": "partner@outside.test",
        "fromAddress": "jane@acme.test",
        "fromName": "Jane Okafor",
        "to": ["partner@outside.test"],
        "subject": "Q3 numbers",
        "bodyText": "Deck attached.",
        "attachments": attachments,
    }).encode("utf-8")


@pytest.mark.asyncio
async def test_the_fetched_bytes_reach_the_mailer(monkeypatch):
    c, mailer = _consumer(monkeypatch, {"a1": b"%PDF-1.4"})

    await c._handle(_event([  # noqa: SLF001
        {"id": "a1", "filename": "q3.pdf", "mime": "application/pdf", "sizeBytes": 8},
    ]))

    assert mailer.sends[0]["attachments"] == [("q3.pdf", "application/pdf", b"%PDF-1.4")]


@pytest.mark.asyncio
async def test_a_file_that_cannot_be_fetched_does_not_cost_the_mail(monkeypatch):
    # The blob outlived its row, or messaging-svc is mid-restart. Failing the
    # mail here would retry the whole thing and deliver the words to nobody.
    c, mailer = _consumer(monkeypatch, {"a1": None})

    assert await c._handle(_event([  # noqa: SLF001
        {"id": "a1", "filename": "q3.pdf", "mime": "application/pdf", "sizeBytes": 8},
    ])) is True
    assert mailer.sends[0]["attachments"] == []
    assert "q3.pdf" in mailer.sends[0]["text_body"]


@pytest.mark.asyncio
async def test_an_oversized_file_is_named_rather_than_dropped_in_silence(monkeypatch):
    # The recipient can ask for a file they know exists; they cannot ask for one
    # they were never told about, in a message that refers to "the attached".
    c, mailer = _consumer(monkeypatch, {})

    await c._handle(_event([  # noqa: SLF001
        {"id": "a1", "filename": "video.mp4", "mime": "video/mp4", "sizeBytes": 90 * MB},
    ]))

    sent = mailer.sends[0]
    assert sent["attachments"] == []
    assert "video.mp4" in sent["text_body"]
    assert "video.mp4" in sent["html_body"]


@pytest.mark.asyncio
async def test_unknown_size_attachments_share_the_remaining_budget(monkeypatch):
    # Regression: before this fix, EVERY unknown-size attachment on the same
    # mail was checked against the FULL per-mail budget independently, so
    # several of them could together land well past the intended cap. The
    # second attachment's ceiling must reflect what the first one actually
    # consumed, not the budget again from scratch.
    seen_budgets: list[int] = []

    async def _record(_client, *, attachment, budget_bytes, **_kw):
        seen_budgets.append(budget_bytes)
        return b"x" * (6 * MB)

    c, mailer = _consumer(monkeypatch, {}, budget=10 * MB)
    monkeypatch.setattr(relay_consumer, "fetch_attachment", _record)

    await c._handle(_event([  # noqa: SLF001
        {"id": "first", "filename": "a.pdf"},  # no sizeBytes -> unknown
        {"id": "second", "filename": "b.pdf"},  # no sizeBytes -> unknown
    ]))

    assert seen_budgets == [10 * MB, 4 * MB]
    assert [a[0] for a in mailer.sends[0]["attachments"]] == ["a.pdf", "b.pdf"]


@pytest.mark.asyncio
async def test_an_unknown_size_attachment_cannot_spend_past_what_the_known_batch_left(monkeypatch):
    # Regression: the unknown-size branch of fetch() built its ceiling from
    # the per-mail budget alone, never checking what the known-size batch
    # (fetched first — see _collect_attachments's own comment on why known-
    # size attachments go first and concurrently, unknown-size ones after and
    # sequentially) had ACTUALLY consumed of it. within_budget only ever
    # compares declared sizes against the budget in isolation, before
    # anything is fetched — so a known-size attachment that "fits" on paper,
    # followed by an unknown-size one sized against the ORIGINAL budget
    # instead of what the known batch actually spent, let the mail's true
    # total sail past the budget the two were supposed to share. This
    # exercises the real fetch() (not the stubbed one _consumer() installs),
    # so the ceiling bug actually gets a chance to manifest.
    known_body = b"y" * (5 * MB)     # declared 5 MB, fetched first: spends 5 of the 10 MB budget
    unknown_body = b"x" * (8 * MB)   # unknown size: only ~5 MB is left for it
    # fetch_attachment validates attachment.id as a UUID (internal_ids.
    # uuid_path_segment) before building the request path, so the fake ids
    # here have to be real UUIDs rather than the readable "known"/"unknown"
    # this test used before that validation existed.
    known_id = "11111111-1111-1111-1111-111111111111"
    unknown_id = "22222222-2222-2222-2222-222222222222"

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(f"/{known_id}"):
            return httpx.Response(200, content=known_body)
        return httpx.Response(200, content=unknown_body)

    settings = _settings()
    settings.mail_attachment_budget_bytes = 10 * MB
    c = RelayConsumer(settings)
    mailer = _RecordingMailer()
    c._mailer = mailer  # noqa: SLF001
    c._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))  # noqa: SLF001

    async def _claim(*_a: str) -> bool:
        return True

    async def _mark_sent(*_a: str) -> None:
        return None

    c._claim = _claim  # noqa: SLF001
    c._mark_sent = _mark_sent  # noqa: SLF001

    await c._handle(_event([  # noqa: SLF001
        {"id": unknown_id, "filename": "a.pdf"},  # no sizeBytes -> unknown
        {"id": known_id, "filename": "b.pdf", "sizeBytes": 5 * MB},
    ]))

    sent = mailer.sends[0]
    # Only ~5 MB was left after the known-size batch actually spent 5 of the
    # 10 MB budget, so the unknown-size file (8 MB on the wire) must be
    # skipped like any other over-budget file, not silently attached on top
    # of what the known batch already spent.
    assert [a[0] for a in sent["attachments"]] == ["b.pdf"]
    assert "a.pdf" in sent["text_body"]


@pytest.mark.asyncio
async def test_an_oversized_file_is_never_fetched(monkeypatch):
    # Spending the budget on metadata is the whole point: downloading 90 MB into
    # a 384 MB container to then discard it is the failure being avoided.
    asked: list[str] = []

    async def _record(_client, *, attachment, **_kw):
        asked.append(attachment.id)
        return b"x"

    c, _ = _consumer(monkeypatch, {})
    monkeypatch.setattr(relay_consumer, "fetch_attachment", _record)

    await c._handle(_event([  # noqa: SLF001
        {"id": "big", "filename": "video.mp4", "mime": "video/mp4", "sizeBytes": 90 * MB},
        {"id": "small", "filename": "agenda.pdf", "mime": "application/pdf", "sizeBytes": 10},
    ]))

    assert asked == ["small"]


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["a-string", 5, {"id": "x"}, None])
async def test_a_malformed_attachments_field_still_sends_the_mail(monkeypatch, bad):
    # This field crossed a topic. A string would iterate as characters and a
    # number would raise — and it is read OUTSIDE the send's try/except, so an
    # exception here escapes the poison-message handling and takes the consumer
    # loop down with it rather than costing one event.
    c, mailer = _consumer(monkeypatch, {})
    event = json.loads(_event([]))
    event["attachments"] = bad

    assert await c._handle(json.dumps(event).encode()) is True  # noqa: SLF001
    assert mailer.sends[0]["attachments"] == []


@pytest.mark.asyncio
async def test_a_mail_with_no_attachments_asks_for_nothing(monkeypatch):
    c, mailer = _consumer(monkeypatch, {})

    await c._handle(_event([]))  # noqa: SLF001

    assert mailer.sends[0]["attachments"] == []
    assert "could not be attached" not in mailer.sends[0]["text_body"]

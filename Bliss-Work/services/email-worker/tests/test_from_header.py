"""Who a relayed mail claims to be from, in the bytes that go on the wire.

Mail a member composes is FROM that member — their display name and their own
address — while the mail the PRODUCT sends (invites, password resets, the
"you have a new message" notices) is from the deployment and must not claim to
be from a person.

The other half is the SMTP envelope, which these also pin because it is invisible
in the message and expensive to get wrong: it stays on the authenticated address
whatever the header says. aiosmtplib derives the envelope from the headers when
it is not told, and a provider that verifies its senders refuses an envelope it
did not authorise — so an unpinned envelope does not mean "slightly worse
deliverability", it means every member's mail fails, five times, into the DLQ.
"""
from __future__ import annotations

import aiosmtplib
import pytest

from app.mailer import Mailer

SENDER = "no-reply@blisswork.test"


@pytest.fixture()
def outbox(monkeypatch) -> list[dict]:
    """Capture what would have been handed to SMTP."""
    sent: list[dict] = []

    async def _capture(message, **kwargs):
        sent.append({"message": message, **kwargs})

    monkeypatch.setattr(aiosmtplib, "send", _capture)
    return sent


def _mailer() -> Mailer:
    return Mailer("mailpit", 1025, SENDER)


async def _send(mailer: Mailer, **kwargs) -> None:
    await mailer.send(
        to="partner@outside.test", subject="Q3 numbers",
        text_body="Deck attached.", html_body="<p>Deck attached.</p>",
        **kwargs,
    )


async def test_the_author_is_the_sender(outbox):
    await _send(_mailer(), from_name="Jane Okafor", from_address="jane@acme.test")

    assert outbox[0]["message"]["From"] == "Jane Okafor <jane@acme.test>"


async def test_the_envelope_stays_on_the_authenticated_address(outbox):
    # Not cosmetic: an envelope taken from the header is refused outright by any
    # provider that verifies its senders, and SPF is checked against this.
    await _send(_mailer(), from_name="Jane Okafor", from_address="jane@acme.test")

    assert outbox[0]["sender"] == SENDER
    assert outbox[0]["recipients"] == ["partner@outside.test"]


async def test_product_mail_is_still_from_the_product(outbox):
    # An invite or a password reset is not from a person and must not say it is.
    await _send(_mailer())

    assert outbox[0]["message"]["From"] == SENDER


async def test_an_address_we_cannot_send_from_falls_back(outbox):
    # A malformed From is rejected by the receiving server, which would lose the
    # mail entirely. The deployment sender still delivers it.
    await _send(_mailer(), from_name="Jane Okafor", from_address="not-an-address")

    assert outbox[0]["message"]["From"] == f"Jane Okafor <{SENDER}>"


async def test_a_name_with_a_comma_stays_one_mailbox(outbox):
    # The f-string this replaced produced `Okafor, Jane <addr>`, which parses as
    # TWO addresses — one of them a bare word — and clients render it as such.
    await _send(_mailer(), from_name="Okafor, Jane", from_address="jane@acme.test")

    assert outbox[0]["message"]["From"] == '"Okafor, Jane" <jane@acme.test>'


async def test_a_reply_to_that_only_repeats_from_is_omitted(outbox):
    await _send(
        _mailer(), from_name="Jane Okafor",
        from_address="jane@acme.test", reply_to="jane@acme.test",
    )

    assert outbox[0]["message"]["Reply-To"] is None


async def test_a_reply_to_that_differs_is_kept(outbox):
    await _send(
        _mailer(), from_name="BlissWork",
        reply_to="support@blisswork.test",
    )

    assert outbox[0]["message"]["Reply-To"] == "support@blisswork.test"


# ── header injection ─────────────────────────────────────────────────────────
#
# Python's email policy REFUSES a header value containing CR or LF by raising,
# same as it does for an attachment filename (see test_mail_attachments.py's
# "cannot inject a header" case). But unlike a filename, the payload here is
# byte-identical on every redelivery — so an unhandled raise is not a transient
# failure, it is a guaranteed, permanent DLQ for a message whose only problem
# is a stray newline in a subject, display name, or address.


async def test_a_newline_in_the_subject_does_not_raise_or_forge_a_header(outbox):
    await _mailer().send(
        to="partner@outside.test", subject="Q3 numbers\r\nBcc: attacker@evil.test",
        text_body="Deck attached.", html_body="<p>Deck attached.</p>",
    )

    assert outbox[0]["message"]["Bcc"] is None
    assert not any(
        line.startswith("Bcc:") for line in outbox[0]["message"].as_string().splitlines()
    )


async def test_a_newline_in_the_display_name_does_not_raise(outbox):
    await _send(
        _mailer(), from_name="Jane\r\nBcc: attacker@evil.test",
        from_address="jane@acme.test",
    )

    assert outbox[0]["message"]["Bcc"] is None


async def test_a_newline_in_display_to_does_not_raise(outbox):
    await _send(_mailer(), display_to=["partner@outside.test\r\nBcc: attacker@evil.test"])

    assert outbox[0]["message"]["Bcc"] is None


async def test_a_newline_in_display_cc_does_not_raise(outbox):
    await _send(_mailer(), display_cc=["cc@outside.test\r\nBcc: attacker@evil.test"])

    assert outbox[0]["message"]["Bcc"] is None


async def test_a_newline_in_reply_to_does_not_raise(outbox):
    await _send(
        _mailer(), from_name="BlissWork",
        reply_to="support@blisswork.test\r\nBcc: attacker@evil.test",
    )

    assert outbox[0]["message"]["Bcc"] is None

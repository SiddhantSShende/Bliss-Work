"""SMTP delivery via aiosmtplib with retry/backoff.

Works with Mailpit (no auth/TLS) for local dev AND with real providers
(Gmail, SendGrid, SES, Resend, …) when SMTP_USERNAME/SMTP_PASSWORD are set —
then it authenticates and (for STARTTLS ports like 587) upgrades the connection.
"""
from __future__ import annotations

import asyncio
import re
from email.message import EmailMessage
from email.utils import formataddr

import aiosmtplib

from .log_safety import recipient_ref, redact_email_addresses
from .logging_setup import get_logger

log = get_logger("mailer")

_MAX_ATTEMPTS = 5
_BASE_DELAY = 0.5  # seconds
_MAX_DELAY = 8.0


class PermanentSMTPError(Exception):
    """An SMTP rejection that will not succeed on an unchanged retry."""

    def __init__(self, code: int) -> None:
        super().__init__(f"permanent SMTP response ({code})")
        self.code = code


def _permanent_smtp_code(exc: BaseException) -> int | None:
    """Return a permanent SMTP response code, including refused recipients."""
    code = getattr(exc, "code", None)
    if not isinstance(code, int):
        code = getattr(getattr(exc, "response", None), "code", None)
    if isinstance(code, int) and 500 <= code <= 599:
        return code

    refused = getattr(exc, "recipients", None)
    if isinstance(refused, dict):
        responses = list(refused.values())
    elif isinstance(refused, (list, tuple)):
        responses = list(refused)
    else:
        responses = []
    if responses:
        codes: list[int] = []
        for response in responses:
            response_code = (
                response[0]
                if isinstance(response, tuple) and response
                else getattr(response, "code", None)
            )
            if isinstance(response_code, int):
                codes.append(response_code)
        if (
            len(codes) == len(responses)
            and all(500 <= response_code <= 599 for response_code in codes)
        ):
            return codes[0]
    return None


# Simple RFC-ish address check: catches the common garbage (empty, missing @,
# whitespace, no domain dot) before we hand it to SMTP — an invalid recipient
# would otherwise be rejected by the server and retried forever. Intentionally
# permissive; full RFC 5322 validation is not worth the complexity here.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(address: str) -> bool:
    """Return True if ``address`` looks like a deliverable e-mail address."""
    return bool(address) and _EMAIL_RE.match(address.strip()) is not None


# Filenames land in a Content-Disposition header. Python's email policy REFUSES
# a value containing CR or LF — correctly, since that is header injection — but
# it refuses by raising, and an exception here would fail the send, retry it, and
# eventually drop the whole message in the DLQ over a bad character in a
# filename. Cleaning it means the mail arrives and the file keeps a usable name.
_UNSAFE_IN_FILENAME = re.compile(r"[\x00-\x1f\x7f]")

# Long enough for any real filename; short enough that the header stays sane.
_MAX_FILENAME = 200


def safe_filename(name: str) -> str:
    """A filename that cannot break, or inject, a header."""
    cleaned = _UNSAFE_IN_FILENAME.sub("", name or "").strip()
    # Path separators would be honoured by some clients on extraction.
    cleaned = cleaned.replace("/", "_").replace("\\", "_")
    cleaned = cleaned[:_MAX_FILENAME].strip()
    return cleaned or "attachment"


# Same problem as a filename (see safe_filename above), for every OTHER header
# value built from event/user-supplied text: Subject, the display To/Cc, and a
# sender's display name or reply address. Python's email policy raises on an
# embedded CR or LF rather than silently stripping it — correct, since it is
# header injection — but for these fields the payload is byte-identical on
# every redelivery, so an unhandled raise here is not a transient failure: it
# is a guaranteed, permanent DLQ for a message whose only problem is a stray
# newline (e.g. pasted multi-line text into a subject that went unstripped
# upstream).
_UNSAFE_IN_HEADER = re.compile(r"[\r\n]")


def safe_header(value: str) -> str:
    """A header value that cannot inject or break the message it rides on."""
    return _UNSAFE_IN_HEADER.sub(" ", value or "").strip()


class Mailer:
    def __init__(
        self,
        host: str,
        port: int,
        sender: str,
        *,
        username: str = "",
        password: str = "",
        starttls: bool = False,
    ) -> None:
        self._host = host
        self._port = port
        self._sender = sender
        self._username = username or None
        self._password = password or None
        # STARTTLS for 587; implicit TLS for 465; plaintext for Mailpit (1025).
        self._start_tls = starttls or port == 587
        self._use_tls = port == 465

    async def send(
        self,
        *,
        to: str,
        subject: str,
        text_body: str,
        html_body: str,
        from_name: str = "",
        from_address: str = "",
        reply_to: str = "",
        display_to: list[str] | None = None,
        display_cc: list[str] | None = None,
        attachments: list[tuple[str, str, bytes]] | None = None,
    ) -> None:
        """Deliver one copy of a message to ONE envelope recipient (``to``).

        The optional keywords exist for user-composed mail relayed out of the
        Inbox, and they are what make that mail both deliverable and honest:

        ``from_name`` / ``from_address`` / ``reply_to``
            Mail a member composed is FROM that member: the header carries their
            display name and their own address, so it arrives looking like what
            it is rather than like a notice from the product.

            The SMTP ENVELOPE sender stays this deployment's authenticated
            address, and that separation is what makes the above deliverable
            rather than merely desirable. The envelope is what the relay
            authorises and what SPF is checked against, so deriving it from the
            header — which is what happens if `sender` is not passed below —
            gets the message refused outright by any provider that verifies its
            senders. Pinned, the mail is accepted and SPF passes.

            What this does NOT do by itself is make the header domain DMARC
            ALIGNED. Alignment needs the author's domain to authorise this
            deployment, so mail from a domain with a strict DMARC policy that
            has not done that will be quarantined. See docs/OPERATIONS.md section 9.

            Both are optional: with no ``from_address`` the deployment's own
            address is used, which is correct for the mail the PRODUCT sends
            (invites, password resets, notifications) — those are not from a
            person and must not claim to be.

        ``attachments``
            ``(filename, mime, data)`` per file, already fetched by the caller —
            this class does no I/O of its own beyond SMTP. Adding one turns the
            message from multipart/alternative into multipart/mixed with the
            text and HTML alternative nested inside it, which is what every mail
            client expects and what ``add_attachment`` does on its own.

        ``display_to`` / ``display_cc``
            The header the RECIPIENTS see, which is not the same thing as who
            this copy goes to. One copy is sent per addressee with the shared
            To/Cc header, so a Bcc'd address never appears in anybody's headers
            — including their own. ``recipients=[to]`` below is what keeps the
            envelope and the header separate; without it aiosmtplib would derive
            the envelope from the headers and deliver to everyone named there.
        """
        # An address we cannot send from is not worth claiming: it would be
        # rejected or land as a forgery, and the fallback still delivers.
        author = from_address.strip() if is_valid_email(from_address) else ""
        message = EmailMessage()
        # Every value below crossed a topic or was typed by a user, same as a
        # filename (see safe_filename) — cleaned for the same reason: raising
        # here over a stray CR/LF would deterministically DLQ the message on
        # every redelivery instead of merely losing the newline.
        display_to = [safe_header(a) for a in display_to] if display_to else None
        display_cc = [safe_header(a) for a in display_cc] if display_cc else None
        # formataddr, not an f-string: it quotes and RFC 2047-encodes the display
        # part, so a name holding a comma ("Okafor, Jane") stays ONE mailbox
        # instead of parsing as two, and a non-ASCII one survives the header.
        message["From"] = formataddr((safe_header(from_name), author or self._sender))
        message["To"] = ", ".join(display_to) if display_to else to
        if display_cc:
            message["Cc"] = ", ".join(display_cc)
        # Redundant once From is the author themselves, and some clients render
        # a Reply-To that merely repeats From as though it were a redirection.
        if reply_to and reply_to != author:
            message["Reply-To"] = safe_header(reply_to)
        message["Subject"] = safe_header(subject)
        message.set_content(text_body)
        message.add_alternative(html_body, subtype="html")
        for filename, mime, data in attachments or []:
            # Same header-injection hazard as the fields above (see safe_header):
            # this mime string comes off a Kafka event, not typed by our own
            # code, and is byte-identical on every redelivery — unsanitized, a
            # stray CR/LF in it would raise on every attempt and DLQ the message
            # permanently.
            maintype, _, subtype = safe_header(mime).partition("/")
            # A type we cannot split is not a type. octet-stream is the correct
            # answer for "bytes of unknown kind" and is what every client falls
            # back to anyway; guessing from the extension here would be guessing
            # about a file we did not open.
            if not maintype or not subtype:
                maintype, subtype = "application", "octet-stream"
            try:
                message.add_attachment(
                    data, maintype=maintype, subtype=subtype,
                    filename=safe_filename(filename),
                )
            except Exception as exc:
                # add_attachment can still refuse a type it does not like (e.g.
                # a maintype/subtype pair it cannot register a handler for).
                # Same reasoning as the unsplittable-mime fallback above: retrying
                # would not change anything about the next attempt, so fall back
                # to the type every client already treats as "just bytes."
                log.warning(
                    "attachment_mime_rejected", filename=filename, mime=mime, error=str(exc),
                )
                message.add_attachment(
                    data, maintype="application", subtype="octet-stream",
                    filename=safe_filename(filename),
                )

        attempt = 0
        while True:
            attempt += 1
            try:
                await aiosmtplib.send(
                    message,
                    hostname=self._host,
                    port=self._port,
                    username=self._username,
                    password=self._password,
                    # Both halves of the envelope are stated explicitly, because
                    # aiosmtplib derives EITHER from the headers when it is not
                    # told. The sender is the address this deployment is
                    # authenticated to send as, whoever the From names; the
                    # recipient is this one copy, never everyone in To/Cc.
                    sender=self._sender,
                    recipients=[to],
                    start_tls=self._start_tls or None,
                    use_tls=self._use_tls,
                    timeout=20,
                )
                log.info(
                    "smtp_sent", recipient_ref=recipient_ref(to),
                    host=self._host, port=self._port,
                )
                return
            except (aiosmtplib.SMTPException, OSError, asyncio.TimeoutError) as exc:
                permanent_code = _permanent_smtp_code(exc)
                if permanent_code is not None:
                    log.error(
                        "smtp_permanent_failure",
                        recipient_ref=recipient_ref(to),
                        code=permanent_code,
                        error=redact_email_addresses(exc),
                    )
                    raise PermanentSMTPError(permanent_code) from exc
                if attempt >= _MAX_ATTEMPTS:
                    log.error(
                        "smtp_send_failed",
                        recipient_ref=recipient_ref(to),
                        attempts=attempt,
                        error=redact_email_addresses(exc),
                    )
                    raise
                delay = min(_BASE_DELAY * (2 ** (attempt - 1)), _MAX_DELAY)
                log.warning(
                    "smtp_send_retry",
                    recipient_ref=recipient_ref(to),
                    attempt=attempt,
                    next_delay_s=delay,
                    error=redact_email_addresses(exc),
                )
                await asyncio.sleep(delay)

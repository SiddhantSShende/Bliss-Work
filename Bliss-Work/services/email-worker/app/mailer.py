"""SMTP delivery via aiosmtplib with retry/backoff.

Works with Mailpit (no auth/TLS) for local dev AND with real providers
(Gmail, SendGrid, SES, Resend, …) when SMTP_USERNAME/SMTP_PASSWORD are set —
then it authenticates and (for STARTTLS ports like 587) upgrades the connection.
"""
from __future__ import annotations

import asyncio
import re
from email.message import EmailMessage

import aiosmtplib

from .logging_setup import get_logger

log = get_logger("mailer")

_MAX_ATTEMPTS = 5
_BASE_DELAY = 0.5  # seconds
_MAX_DELAY = 8.0

# Simple RFC-ish address check: catches the common garbage (empty, missing @,
# whitespace, no domain dot) before we hand it to SMTP — an invalid recipient
# would otherwise be rejected by the server and retried forever. Intentionally
# permissive; full RFC 5322 validation is not worth the complexity here.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(address: str) -> bool:
    """Return True if ``address`` looks like a deliverable e-mail address."""
    return bool(address) and _EMAIL_RE.match(address.strip()) is not None


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

    async def send(self, *, to: str, subject: str, text_body: str, html_body: str) -> None:
        message = EmailMessage()
        message["From"] = self._sender
        message["To"] = to
        message["Subject"] = subject
        message.set_content(text_body)
        message.add_alternative(html_body, subtype="html")

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
                    start_tls=self._start_tls or None,
                    use_tls=self._use_tls,
                    timeout=20,
                )
                log.info("smtp_sent", to=to, host=self._host, port=self._port)
                return
            except (aiosmtplib.SMTPException, OSError, asyncio.TimeoutError) as exc:
                if attempt >= _MAX_ATTEMPTS:
                    log.error("smtp_send_failed", to=to, attempts=attempt, error=str(exc))
                    raise
                delay = min(_BASE_DELAY * (2 ** (attempt - 1)), _MAX_DELAY)
                log.warning("smtp_send_retry", to=to, attempt=attempt, next_delay_s=delay, error=str(exc))
                await asyncio.sleep(delay)

#!/usr/bin/env python3
"""Send one operational alert email over the configured SMTP account.

Reads everything from the environment so no secret is ever passed on a command
line, where it would be visible in `ps` to every user on the box:

    SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASSWORD SMTP_FROM
    ALERT_TO SUBJECT BODY

Deliberately stdlib-only. This runs from a systemd timer on a host with no
application virtualenv on PATH, and an alerting path that can break because a
dependency moved is not an alerting path.

Exits non-zero on failure so the caller can decline to record "already alerted"
and retry on the next run — a swallowed send is indistinguishable from a healthy
system, which is the one failure mode an alert must not have.
"""
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage

REQUIRED = ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM", "SUBJECT", "BODY")


def main() -> int:
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"send-alert: missing {', '.join(missing)}", file=sys.stderr)
        return 2

    to_addr = os.environ.get("ALERT_TO") or os.environ["SMTP_FROM"]
    port = int(os.environ.get("SMTP_PORT") or 587)

    msg = EmailMessage()
    msg["From"] = os.environ["SMTP_FROM"]
    msg["To"] = to_addr
    msg["Subject"] = os.environ["SUBJECT"]
    # Alerts are transactional, not marketing: ask clients not to auto-reply and
    # mark them so a mail rule can file them without matching on the subject.
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-BlissWork-Alert"] = "1"
    msg.set_content(os.environ["BODY"])

    try:
        # Timeout on every leg: a hung SMTP connection would otherwise pin the
        # systemd unit open until the next run collides with it.
        with smtplib.SMTP(os.environ["SMTP_HOST"], port, timeout=30) as smtp:
            smtp.ehlo()
            if (os.environ.get("SMTP_STARTTLS", "true").lower() != "false") and port != 465:
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            smtp.login(os.environ["SMTP_USERNAME"], os.environ["SMTP_PASSWORD"])
            smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001 — the reason matters more than the type
        # Never echo the exception's full repr: SMTP libraries have been known to
        # include credentials in connection errors.
        print(f"send-alert: delivery failed ({type(exc).__name__}: {exc})", file=sys.stderr)
        return 1

    print(f"send-alert: sent to {to_addr}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

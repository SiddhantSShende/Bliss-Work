"""Sending a member's mail through that member's OWN connected mailbox.

── Why this exists ──────────────────────────────────────────────────────────
The SMTP relay authenticates as ONE address for the whole deployment. Every
mail it sends therefore leaves under that address, and a mail a member composed
can only claim to be theirs: the From: header says so while nothing about the
message backs it up. Recipients on a corporate mail system see exactly that —
an unfamiliar third party asserting somebody's identity — and filter it
accordingly. The member also has no record of having sent it, because nothing
ever touched their mailbox.

Sending through their own mailbox fixes all three at once, and not by
configuration but by construction: the From: header is their address because
the mailbox IS theirs, their provider signs it with their domain's key so it
passes DMARC alignment instead of arriving unauthenticated, and the provider
files the copy in their Sent folder.

── Why a 404 is not a failure ───────────────────────────────────────────────
Most deployments have no mailbox connected, and every deployment has members
who have not connected one. `send` answers False for those rather than raising,
and the caller relays the copy over SMTP exactly as before. Only a genuinely
transient fault raises, because only that is worth redelivering the event for.

── Why the breaker fails OPEN to the relay ──────────────────────────────────
integrations-svc is an auxiliary here: it makes a mail better, it is not what
makes it deliverable. So a sustained outage must not hold outbound mail —
retrying forever would leave everybody's mail sitting on the topic waiting for
a service that has nothing to do with whether it can be sent. Once the breaker
opens, `send` answers False and the copies go out over SMTP under the old
identity: worse mail, but mail.
"""
from __future__ import annotations

import base64

import httpx

from .logging_setup import get_logger
from resilience import CircuitBreaker, CircuitOpenError, retry_async

log = get_logger("provider_mail")

# Generous relative to the 3s user lookup and aligned with the attachment fetch:
# this request can carry megabytes of base64 to the provider.
SEND_TIMEOUT = 30.0

_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="integrations-svc-mail")


class ProviderMailUnavailable(Exception):
    """A transient fault — a token mid-refresh, a throttled provider, a restart.

    Worth redelivering the event for, unlike "this member has no mailbox".
    """


async def send(
    client: httpx.AsyncClient,
    base_url: str,
    internal_token: str,
    *,
    org_id: str,
    author_id: str,
    mail_id: str,
    subject: str,
    text_body: str,
    html_body: str,
    to: list[str],
    cc: list[str],
    bcc: list[str],
    attachments: list[tuple[str, str, bytes]],
) -> bool:
    """Send one mail through the author's mailbox. False if they have none.

    Raises ProviderMailUnavailable on a transient fault. Every other outcome —
    no connected mailbox, a message the provider will not accept, a malformed
    request — answers False, because the SMTP relay can still deliver it and a
    mail that goes out late by another route beats one that never goes out.

    `mail_id` is integrations-svc's idempotency key for this call (see its
    0013_mail_send_idempotency.sql): the SAME mail_id sent more than once —
    this call's own retry_async, or a Kafka redelivery calling `send` again
    from scratch after _record_transport lost the result — is deduplicated
    there rather than triggering a second real email.

    A 409 (the claim is ambiguous or already owned by another in-flight
    attempt) always raises too, and — unlike a 5xx — can never accumulate
    into a breaker-open False. Treating it as "safe, use the relay" would
    reintroduce the exact duplicate the idempotency claim exists to prevent:
    a run of these opening the breaker used to fall through to `except
    CircuitOpenError: return False` below, which _decide_transport reads
    exactly like "no mailbox" and relays a mail that may already be sitting
    in the recipient's inbox.
    """
    if not author_id or not (to or cc or bcc):
        return False

    payload = {
        "orgId": org_id,
        "userId": author_id,
        "mailId": mail_id,
        "subject": subject,
        "bodyText": text_body,
        "bodyHtml": html_body,
        "to": to,
        "cc": cc,
        "bcc": bcc,
        "attachments": [
            {
                "filename": name,
                "mime": mime,
                "contentBase64": base64.b64encode(data).decode("ascii"),
            }
            for name, mime, data in attachments
        ],
    }
    async def _attempt() -> bool:
        r = await client.post(
            f"{base_url.rstrip('/')}/internal/mail/send",
            headers={"X-Internal-Token": internal_token},
            json=payload,
            timeout=httpx.Timeout(SEND_TIMEOUT),
        )
        if r.status_code == 200:
            return True
        if r.status_code == 404:
            # The ordinary case, not a fault: no connected mailbox.
            return False
        if r.status_code == 409:
            # The claim for this mail_id is ambiguous or still owned by
            # another in-flight attempt (see 0013_mail_send_idempotency.sql
            # and _claim_mail_send). Unlike every other answer here this one
            # must NEVER become `False` — that tells the caller "nothing was
            # sent, use the relay", and Graph may already have delivered this
            # exact mail. raise_for_status() keeps it classified as
            # non-transient (a 409 is below is_transient's >= 500 floor), so
            # retry_async neither retries it nor counts it against the
            # breaker — it can't accumulate into a CircuitOpenError that
            # would fall through to the relay either. It always surfaces
            # below as ProviderMailUnavailable instead.
            r.raise_for_status()
        if r.status_code >= 500:
            # Becomes an HTTPStatusError, which retry_async classifies as
            # transient and the breaker counts. Deliberately NOT a bare
            # raise_for_status(): that would raise on the 4xx below too, and
            # turn a refusal the provider will simply repeat into a retry loop.
            r.raise_for_status()
        # 4xx that is not a 404: the provider refused this specific message —
        # most often because its attachments are too large to send inline.
        # Retrying reproduces it exactly; the relay will not.
        log.warning(
            "provider_mail_rejected", status=r.status_code, org=org_id, author=author_id
        )
        return False

    try:
        # idempotent=False: integrations-svc's /internal/mail/send triggers a
        # real provider send on every execution. A ReadTimeout on THIS hop
        # doesn't mean the send failed — it may already have gone out — so it
        # must not be retried.
        return await retry_async(_attempt, attempts=3, breaker=_breaker, idempotent=False)
    except CircuitOpenError:
        # integrations-svc is known-bad. See the module note: mail goes out over
        # the relay rather than waiting for a service it does not depend on.
        log.warning("provider_mail_breaker_open", org=org_id, author=author_id)
        return False
    except (httpx.HTTPError, OSError) as exc:
        raise ProviderMailUnavailable(str(exc)) from exc

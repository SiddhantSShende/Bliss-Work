"""Fetching the files on an outbound mail, and deciding which of them fit.

The bytes live on a volume mounted into messaging-svc alone, so they are asked
for over its internal API rather than read off a shared disk — the same boundary
that has this worker ask auth-svc for a member's address instead of reading
authdb. The Kafka event carries only metadata, which is what makes the decision
below possible without moving a byte first.

── Why there is a budget at all ─────────────────────────────────────────────
An upload is capped at MEDIA_MAX_BYTES, 100 MB by default. Mail is not: Gmail
refuses at 25 MB, most providers somewhere between 10 and 25, and base64 adds a
third on top of whatever is measured here. A file that cannot be delivered
should not be fetched, encoded and then rejected by the far end — that is a
message lost, several minutes of retries, and a copy of the file held in the
memory of a container limited to 384 MB.

So the budget is checked against metadata BEFORE anything is downloaded, and
what does not fit is named in the mail instead of silently vanishing. The
recipient learns a file exists; the in-app copy, which has no such limit, still
carries every one of them.
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx

from .logging_setup import get_logger

log = get_logger("attachments")

# Bounded per-file, so one hung transfer cannot pin the consumer. Generous
# compared with the 3s user lookup: this moves megabytes, not a JSON object.
FETCH_TIMEOUT = 30.0

# Slack over the declared size before a transfer is treated as lying. Small and
# fixed: it absorbs an off-by-a-block accounting difference, not a real mismatch.
_SIZE_SLACK = 4096


@dataclass(frozen=True)
class Attachment:
    """One file named on a mail.outbound event."""

    id: str
    filename: str
    mime: str
    # None means the event's declared size could not be trusted (missing,
    # non-numeric, or negative) — distinct from an actual declared 0. Collapsing
    # that case to 0 used to make within_budget treat the file as costing
    # nothing, while fetch()'s ceiling was built from that same phantom 0 — so a
    # real, comfortably-within-budget file got dropped after ~4KB. See
    # within_budget and fetch for how the two sides now agree on what "unknown"
    # means.
    size_bytes: int | None

    @classmethod
    def from_event(cls, raw: object) -> "Attachment | None":
        """Read one entry off the event, or None if it is not usable.

        Everything here crossed a topic, so nothing is assumed about its shape.
        An entry without an id names no file that could be fetched; a negative
        or absurd size is not trusted into the arithmetic below — it becomes
        size_bytes=None rather than a silently-wrong 0.
        """
        if not isinstance(raw, dict):
            return None
        att_id = str(raw.get("id") or "")
        if not att_id:
            return None
        try:
            size = int(raw.get("sizeBytes"))
        except (TypeError, ValueError):
            size = None
        if size is not None and size < 0:
            size = None
        return cls(
            id=att_id,
            filename=str(raw.get("filename") or "attachment"),
            mime=str(raw.get("mime") or "application/octet-stream"),
            size_bytes=size,
        )


def within_budget(
    attachments: list[Attachment], budget_bytes: int
) -> tuple[list[Attachment], list[Attachment]]:
    """Split the list into what will be attached and what will not.

    Files are taken in the order they were attached, and one that does not fit
    does NOT stop the ones after it: a 90 MB video first in the list would
    otherwise suppress the 40 KB agenda behind it, which is the opposite of
    useful. A single file larger than the whole budget is simply never taken.

    A budget of zero or less disables the relay of attachments entirely, which
    is a deployment's way of saying "this SMTP route does not carry files".
    """
    if budget_bytes <= 0:
        return [], list(attachments)
    fits: list[Attachment] = []
    skipped: list[Attachment] = []
    remaining = budget_bytes
    for att in attachments:
        if att.size_bytes is None:
            # Unknown, not free: this file cannot be checked against the
            # budget ahead of time, so it is let through provisionally instead
            # of dropped over metadata alone — but it must not reserve any of
            # the remaining allowance, since its real cost is still unknown.
            # fetch() enforces the actual ceiling once bytes start arriving.
            fits.append(att)
            continue
        if att.size_bytes <= remaining:
            fits.append(att)
            remaining -= att.size_bytes
        else:
            skipped.append(att)
    return fits, skipped


async def fetch(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    token: str,
    org_id: str,
    mail_id: str,
    attachment: Attachment,
    budget_bytes: int,
) -> bytes | None:
    """Download one attachment's bytes, or None if it cannot be had.

    None rather than an exception, and the caller sends the mail anyway. A file
    whose row outlived its blob, or a messaging-svc that is briefly unreachable,
    must not turn into an undeliverable message — the words someone wrote are
    the part that matters, and a retry would put the whole mail back on the
    queue to fix one of its files.
    """
    url = f"{base_url.rstrip('/')}/internal/mail/{mail_id}/attachments/{attachment.id}"
    # Streamed with a ceiling rather than read whole. The budget was spent
    # against the size the EVENT declared, and this is where that claim is
    # actually tested: a response longer than declared is abandoned mid-transfer
    # instead of being buffered into a container with 384 MB to its name.
    if attachment.size_bytes is not None:
        ceiling = attachment.size_bytes + _SIZE_SLACK
    else:
        # within_budget let this one through without knowing its real size —
        # the only ceiling that still means anything is the per-mail budget
        # itself, not a few KB of slack around a declared size we don't have.
        ceiling = max(budget_bytes, 0)
    try:
        async with client.stream(
            "GET",
            url,
            params={"orgId": org_id},
            headers={"X-Internal-Token": token},
            timeout=FETCH_TIMEOUT,
        ) as resp:
            if resp.status_code != 200:
                log.warning("attachment_fetch_rejected", mail_id=mail_id,
                            attachment_id=attachment.id, status=resp.status_code)
                return None
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > ceiling:
                    log.warning("attachment_larger_than_declared", mail_id=mail_id,
                                attachment_id=attachment.id,
                                declared=attachment.size_bytes)
                    return None
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        log.warning("attachment_fetch_failed", mail_id=mail_id,
                    attachment_id=attachment.id, error=str(exc))
        return None
    return b"".join(chunks)

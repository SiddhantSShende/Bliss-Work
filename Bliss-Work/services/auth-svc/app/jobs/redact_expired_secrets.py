"""Strip the raw secret URL from outbox rows once their token has expired.

    python -m app.jobs.redact_expired_secrets
    python -m app.jobs.redact_expired_secrets --dry-run

WHY THIS EXISTS
---------------
Three event types — `password.reset.requested`, `email.verification.requested`,
`invite.created` — carry a raw single-use secret (a reset/verify/invite URL) in
their `outbox.payload`. That row is the ONLY place the secret is ever stored
(the poller redacts it before publishing to Kafka; email-worker pulls it back
via an authenticated internal call — see
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 3). The row itself, though, isn't
touched by that redaction and would otherwise sit there — readable by anyone
with database access — for the outbox's full multi-day retention window
(prune_event_tables.py), long after the token itself is useless.

This job closes that gap: once a token's own `expiresAt` has passed, there is
nothing left for the secret to protect, so the URL fields are nulled out. The
row itself is untouched otherwise (`published_at`, `dead_lettered_at` etc.) —
this is redaction, not deletion; prune_event_tables.py still owns when the row
is removed entirely.

WHY NO BATCHING
---------------
Every other job in this directory batches because it deletes from a table
that grows with platform-wide use over the table's entire lifetime. This one
only ever touches rows for three event types, in the narrow window between
"pending or just-published" and "past its own expiresAt" — at most a handful
at any moment, not a multi-year backlog. A single UPDATE is the right size for
that; adding ctid-batching here would be complexity with nothing to pay for.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import text

from ..db import engine
from ..events.outbox import SECRET_EVENT_TYPES
from ..logging_config import log

_URL_FIELDS = ("resetUrl", "verifyUrl", "inviteUrl")


async def run(*, dry_run: bool = False) -> int:
    """Redact expired secret URLs. Returns how many rows were touched."""
    types = list(SECRET_EVENT_TYPES)
    # `payload ?| array[...]` (jsonb "has any of these keys") skips rows
    # already redacted, so a repeat run only ever touches genuinely new work.
    eligible_where = """
        payload ->> 'type' = ANY(:types)
        AND (payload ->> 'expiresAt')::timestamptz < now()
        AND payload ?| array['resetUrl', 'verifyUrl', 'inviteUrl']
    """
    if dry_run:
        async with engine.connect() as conn:
            n = (
                await conn.execute(
                    text(f"SELECT count(*) FROM outbox WHERE {eligible_where}"),  # noqa: S608 — fixed table, no user input
                    {"types": types},
                )
            ).scalar_one()
        log.info("redact_expired_secrets_would_redact", rows=n)
        return n

    async with engine.begin() as conn:
        result = await conn.execute(
            text(
                f"""
                UPDATE outbox
                SET payload = payload - 'resetUrl' - 'verifyUrl' - 'inviteUrl'
                WHERE {eligible_where}
                """  # noqa: S608 — fixed table, no user input
            ),
            {"types": types},
        )
    redacted = result.rowcount or 0
    log.info("redact_expired_secrets_done", redacted=redacted)
    return redacted


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Strip the raw secret URL from outbox rows past their token's expiry."
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="report how many rows are eligible, redact nothing",
    )
    args = ap.parse_args()
    try:
        count = asyncio.run(run(dry_run=args.dry_run))
    except Exception:  # pragma: no cover - operational entrypoint
        log.exception("redact_expired_secrets_failed")
        sys.exit(1)
    print(f"{'would redact' if args.dry_run else 'redacted'} {count} outbox row(s)")


if __name__ == "__main__":
    main()

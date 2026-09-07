"""ONE-TIME remediation: expire every outstanding password-reset / email-verify
/ invite token, because the raw secret used to be broadcast to every consumer
of `auth.events` (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 3).

    python -m app.jobs.expire_pending_secrets_once
    python -m app.jobs.expire_pending_secrets_once --dry-run

THIS IS NOT A RECURRING JOB.
----------------------------
Unlike everything else in app/jobs/, this has no systemd timer and is meant
to run EXACTLY ONCE, by hand, as part of deploying Phase 3 — after the
poller/internal-endpoint code above has shipped (so a newly-requested token
isn't immediately invalidated by this same run), and before any Kafka-ACL
follow-up work. Anyone with an outstanding reset/verify/invite link has to
re-request one.

WHY THIS IS NECESSARY AND NOT OPTIONAL
---------------------------------------
Every raw token minted before this deploy was published, in full, to `auth.
events` — a topic with no broker-level ACL enforcement, consumed by every
other service on the platform. The code fix stops this going forward; it
does nothing about a link that already went out over that topic. The only
way to close that specific exposure is to make every currently-outstanding
token unusable.

WHAT THIS TOUCHES
------------------
  * user_tokens (purpose IN ('password_reset', 'email_verify')) — status
    'pending' rows are marked 'used' (the existing single-use consume
    semantics; NOT deleted, so this reads identically to "someone already
    redeemed it" rather than inventing a new state).
  * invites (status = 'pending') — marked 'superseded' (existing lifecycle
    status this schema already understands, see account_service.py/
    invites_service.py) rather than 'accepted' — nobody accepted these, and a
    generic 400 "invalid or expired invite" is the correct answer.

Both are simple UPDATEs, not batched: this runs once, against however many
tokens happen to be outstanding at that moment, not a multi-year backlog.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import text

from .. import service
from ..db import engine
from ..logging_config import log


async def run(*, dry_run: bool = False) -> tuple[int, int]:
    """Expire every pending token/invite. Returns (tokens, invites) touched."""
    if dry_run:
        async with engine.connect() as conn:
            # user_tokens/invites are RLS (FORCE ROW LEVEL SECURITY) and this
            # touches every org at once by design (see module docstring) — no
            # single app.org_id applies, so bypass is the only correct
            # context here, same as the migration runner (app/db.py) and
            # purge_orgs.py use for other whole-platform operations. Without
            # it these SELECT COUNTs silently return 0 regardless of how
            # many rows actually match.
            await service.set_bypass_rls(conn)
            tokens = (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM user_tokens WHERE status = 'pending' "
                        "AND purpose IN ('password_reset', 'email_verify')"
                    )
                )
            ).scalar_one()
            invites = (
                await conn.execute(
                    text("SELECT count(*) FROM invites WHERE status = 'pending'")
                )
            ).scalar_one()
        log.info("expire_pending_secrets_would_touch", tokens=tokens, invites=invites)
        return tokens, invites

    async with engine.begin() as conn:
        # Same reasoning as the dry-run branch above: no org context applies
        # to a whole-platform remediation, so these UPDATEs need bypass or
        # they silently touch zero rows.
        await service.set_bypass_rls(conn)
        token_result = await conn.execute(
            text(
                "UPDATE user_tokens SET status = 'used', used_at = now() "
                "WHERE status = 'pending' "
                "AND purpose IN ('password_reset', 'email_verify')"
            )
        )
        invite_result = await conn.execute(
            text("UPDATE invites SET status = 'superseded' WHERE status = 'pending'")
        )
    tokens = token_result.rowcount or 0
    invites = invite_result.rowcount or 0
    log.info("expire_pending_secrets_done", tokens=tokens, invites=invites)
    return tokens, invites


def main() -> None:
    ap = argparse.ArgumentParser(
        description=(
            "ONE-TIME: expire every outstanding password-reset/email-verify "
            "token and pending invite. Run exactly once when deploying "
            "Phase 3 of docs/AUTH_AUTHZ_REMEDIATION_PLAN.md."
        )
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="report how many rows would be touched, change nothing",
    )
    args = ap.parse_args()
    try:
        tokens, invites = asyncio.run(run(dry_run=args.dry_run))
    except Exception:  # pragma: no cover - operational entrypoint
        log.exception("expire_pending_secrets_failed")
        sys.exit(1)
    verb = "would expire" if args.dry_run else "expired"
    print(f"{verb} {tokens} token(s) and {invites} invite(s)")


if __name__ == "__main__":
    main()

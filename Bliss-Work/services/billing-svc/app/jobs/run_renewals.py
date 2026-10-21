"""Monthly renewal: debit each due MEMBERSHIP for its own per-membership cost.

    python -m app.jobs.run_renewals
    python -m app.jobs.run_renewals --dry-run

Per-membership (revised plan, phase 6): each membership has its own trial
window and renewal anchor. Charges `billing_accounts` via the normal ledger
and advances the membership's `next_renewal_at`. A membership that can't
afford its renewal moves to `cycle_status='grace'` (first miss) and then
`'suspended'` (grace deadline passed) — see `app/renewal.py` for the full
state machine and the outbox events it emits.

`--dry-run` reports what each due membership would be charged without
debiting, writing a renewal_runs row, or advancing its renewal date.

Scheduling: not yet wired into infra/systemd — see infra/systemd/README.md
for the convention this should follow once enabled (a oneshot .service +
daily .timer, invoked via `scripts/run-billing-renewals.sh` the same way
`scripts/purge-orgs.sh` drives auth-svc's purge job).
"""
from __future__ import annotations

import asyncio
import sys

from ..db import session
from ..logging_setup import log
from ..renewal import run_due_renewals


async def main(dry_run: bool) -> int:
    outcomes = await run_due_renewals(session, dry_run=dry_run)
    failures = 0
    for o in outcomes:
        log.info(
            "renewal_outcome",
            org_id=o.org_id,
            user_id=o.user_id,
            status=o.status,
            credits_due=o.credits_due,
            reason=o.reason,
            dry_run=dry_run,
        )
        if o.status in ("insufficient_funds", "suspended"):
            failures += 1
    log.info("renewal_run_complete", total=len(outcomes), insufficient_funds=failures, dry_run=dry_run)
    return 0


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv[1:]
    sys.exit(asyncio.run(main(dry_run)))

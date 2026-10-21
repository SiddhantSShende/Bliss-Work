"""Monthly renewal: debit each due org for its current membership commitment.

    python -m app.jobs.run_renewals
    python -m app.jobs.run_renewals --dry-run

Debit-only (phase 5): charges `billing_accounts` via the normal ledger and
advances `org_billing_state.next_renewal_at`. An org that cannot afford its
renewal gets a `billing_renewal_runs` row with status 'insufficient_funds'
and is otherwise left untouched — no suspension, no grace timer, no
notification. Those are a later phase, deliberately not here.

`--dry-run` reports what each due org would be charged without debiting,
writing a renewal_runs row, or advancing the org's renewal date.

Scheduling: not yet wired into infra/systemd — see infra/systemd/README.md
for the convention this should follow once enabled (a oneshot .service +
daily .timer, invoked via `scripts/run-billing-renewals.sh` the same way
`scripts/purge-orgs.sh` drives auth-svc's purge job). Left as a documented,
dry-run-testable entry point rather than wiring a timer in prod before
grace/suspension exist to act on an insufficient-funds outcome.
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
            status=o.status,
            credits_due=o.credits_due,
            reason=o.reason,
            dry_run=dry_run,
        )
        if o.status == "insufficient_funds":
            failures += 1
    log.info("renewal_run_complete", total=len(outcomes), insufficient_funds=failures, dry_run=dry_run)
    return 0


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv[1:]
    sys.exit(asyncio.run(main(dry_run)))

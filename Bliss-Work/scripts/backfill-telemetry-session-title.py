#!/usr/bin/env python3
"""One-time backfill: encrypt any residual plaintext activity_sessions.title
into title_enc, added by 0008_encrypt_activity_session_title.sql.

WHEN NEEDED
  Only for rows written before that migration shipped — sessionizer.py now
  writes ONLY title_enc (see its _upsert_session / _reanchor_standalone_site_
  session), so a telemetry-svc first deployed WITH this migration accumulates
  no new plaintext to backfill.

WHY IT'S SAFE
  * Reuses telemetry-svc's OWN Cryptor (per-org DEK envelope) so ciphertext
    matches exactly what the app writes.
  * Only fills title_enc where it is currently NULL (never overwrites existing
    ciphertext), then NULLs the plaintext title.
  * --dry-run reports the affected rows read-only; --apply commits per row.
  * Runs under app.bypass_rls (cross-org maintenance), mirroring the consumer
    and scripts/backfill-task-plaintext.py, which this script otherwise
    mirrors closely.

USAGE (run where the telemetry-svc `app` package + DATA_* KEK env + Postgres
are all reachable — easiest inside the telemetry-svc container):

  docker compose cp scripts/backfill-telemetry-session-title.py telemetry-svc:/tmp/
  docker compose exec telemetry-svc python /tmp/backfill-telemetry-session-title.py --dry-run
  docker compose exec telemetry-svc python /tmp/backfill-telemetry-session-title.py --apply
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

try:  # inside the telemetry-svc container the `app` package + local crypto
    # package are already importable (crypto is pip-installed from
    # services/shared/crypto)
    from app.config import settings
    from app.db import init_engine, session, set_bypass_rls
    from crypto import cryptor, init_cryptor
except ModuleNotFoundError:  # running from the repo root — add both to sys.path
    _repo_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(_repo_root / "services" / "telemetry-svc"))
    sys.path.insert(0, str(_repo_root / "services" / "shared" / "crypto"))
    from app.config import settings
    from app.db import init_engine, session, set_bypass_rls
    from crypto import cryptor, init_cryptor


async def run(apply: bool) -> int:
    init_engine()
    init_cryptor(settings)
    async with session() as db:
        # Cross-org maintenance: see + write every org's rows and org_keys.
        await set_bypass_rls(db)
        rows = (
            await db.execute(
                text(
                    "SELECT id, org_id, title "
                    "FROM activity_sessions "
                    "WHERE title_enc IS NULL AND COALESCE(length(title), 0) > 0"
                )
            )
        ).all()

    print(f"{len(rows)} activity_sessions row(s) with residual plaintext title")
    if not rows:
        print("nothing to backfill.")
        return 0
    if not apply:
        print("dry-run: pass --apply to encrypt + clear the plaintext.")
        return 0

    fixed = 0
    for r in rows:
        org = str(r.org_id)
        async with session() as db:
            await set_bypass_rls(db)
            title_enc = await cryptor().encrypt(db, org, r.title)
            await db.execute(
                text(
                    "UPDATE activity_sessions SET "
                    "  title_enc = COALESCE(title_enc, :te), "
                    "  title = NULL "
                    "WHERE id = :id"
                ),
                {"te": title_enc, "id": r.id},
            )
            await db.commit()
        fixed += 1

    print(f"backfilled {fixed} row(s); plaintext title cleared.")
    return 0


if __name__ == "__main__":
    apply = "--apply" in sys.argv[1:]
    raise SystemExit(asyncio.run(run(apply)))

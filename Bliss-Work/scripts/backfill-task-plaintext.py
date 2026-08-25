#!/usr/bin/env python3
"""One-time backfill: encrypt any residual plaintext tasks.title / description
into title_enc / description_enc BEFORE 005_drop_plaintext_task_cols.sql drops the
plaintext columns.

WHEN NEEDED
  Only if the 005 migration's guard trips — i.e. rows created before
  003_column_encryption still hold cleartext. A prod first deployed WITH
  encryption has none, and 005 drops the columns cleanly with no backfill.

WHY IT'S SAFE
  * Reuses task-svc's OWN Cryptor (per-org DEK envelope) so ciphertext matches
    exactly what the app writes.
  * Only fills *_enc where it is currently NULL (never overwrites existing
    ciphertext), then NULLs the plaintext.
  * --dry-run reports the affected rows read-only; --apply commits once.
  * Runs under app.bypass_rls (cross-org maintenance), mirroring the consumer.

USAGE (run where the task-svc `app` package + DATA_* KEK env + Postgres are all
reachable — easiest inside the task-svc container):

  docker compose cp scripts/backfill-task-plaintext.py task-svc:/tmp/
  docker compose exec task-svc python /tmp/backfill-task-plaintext.py --dry-run
  docker compose exec task-svc python /tmp/backfill-task-plaintext.py --apply
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

try:  # inside the task-svc container the `app` package + local crypto package
    # are already importable (crypto is pip-installed from services/shared/crypto)
    from app.config import settings
    from app.db import init_engine, session, set_bypass_rls
    from crypto import cryptor, init_cryptor
except ModuleNotFoundError:  # running from the repo root — add both to sys.path
    _repo_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(_repo_root / "services" / "task-svc"))
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
                    "SELECT id, org_id, title, description, "
                    "       (title_enc IS NULL) AS need_title, "
                    "       (description_enc IS NULL) AS need_desc "
                    # Only NON-EMPTY plaintext needs migrating — post-003 rows leave
                    # title NULL and description at its DEFAULT '' (not real PII).
                    "FROM tasks "
                    "WHERE COALESCE(length(title), 0) > 0 "
                    "   OR COALESCE(length(description), 0) > 0"
                )
            )
        ).all()

    print(f"{len(rows)} task row(s) with residual plaintext")
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
            title_enc = (
                await cryptor().encrypt(db, org, r.title or "")
                if r.need_title and r.title is not None
                else None
            )
            desc_enc = (
                await cryptor().encrypt(db, org, r.description or "")
                if r.need_desc and r.description is not None
                else None
            )
            await db.execute(
                text(
                    "UPDATE tasks SET "
                    "  title_enc = COALESCE(title_enc, :te), "
                    "  description_enc = COALESCE(description_enc, :de), "
                    "  title = NULL, description = NULL "
                    "WHERE id = :id"
                ),
                {"te": title_enc, "de": desc_enc, "id": r.id},
            )
            await db.commit()
        fixed += 1

    print(f"backfilled {fixed} row(s); plaintext cleared. Safe to run migration 005.")
    return 0


if __name__ == "__main__":
    apply = "--apply" in sys.argv[1:]
    raise SystemExit(asyncio.run(run(apply)))

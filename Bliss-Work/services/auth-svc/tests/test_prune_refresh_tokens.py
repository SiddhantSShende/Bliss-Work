"""Retention contract for ``app.jobs.prune_refresh_tokens``.

The dangerous mistake this guards is not deleting too little — it is deleting
the wrong rows, and the damage is invisible.

`refresh_tokens` grows a row per refresh forever, so it plainly needs a prune.
The obvious rule is "delete revoked rows", and that rule silently disables theft
detection: rotation revokes a token when it is exchanged, and finding that
revoked row on a later presentation is exactly what identifies a replay and
tears down the family. Delete it early and the identical replay reads as an
unknown token — still refused, so nothing looks broken, but the rest of the
attacker's stolen family keeps working and nobody is told.

Expiry is the honest line: past `expires_at` a replay is refused regardless, so
the row has nothing left to prove.

These are pure-logic checks on the SQL and the constants — no database.
"""
from __future__ import annotations

import re

import pytest

prune = pytest.importorskip(
    "app.jobs.prune_refresh_tokens",
    reason="auth-svc deps not installed locally; CI installs requirements.txt.",
)

# Deliberately below importorskip: these are only needed once the module under
# test has actually loaded, and hoisting them would put stdlib imports above the
# skip guard for no benefit.
import ast  # noqa: E402
import inspect  # noqa: E402

_SOURCE = inspect.getsource(prune)


def _sql_statements(tree: ast.AST) -> list[str]:
    """The strings this module hands to SQLAlchemy's ``text()``, and only those.

    Two cheaper approaches both give the WRONG answer here, in the same
    direction, which is worth recording so nobody re-simplifies it:

      * a regex over the source finds `revoked` in the long comment explaining
        why the prune does not filter on `revoked`, and concludes the opposite
        of the truth;
      * collecting every string literal containing SELECT/DELETE picks up the
        module docstring, which quotes an example `DELETE ... WHERE expires_at`.

    Both make the test fail on correct code — the worst kind of false alarm,
    because the obvious response is to weaken the assertion. Reading the
    argument to ``text()`` has no such ambiguity: those strings are the
    statements, and nothing else is.
    """
    out: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", None)
        if name != "text" or not node.args:
            continue
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            out.append(" ".join(arg.value.split()))
    return out


_TREE = ast.parse(_SOURCE)
_SQL = _sql_statements(_TREE)


def test_module_actually_issues_sql():
    """Guards the guard: if the extraction found nothing, every assertion below
    would pass vacuously."""
    assert _SQL, "no SQL literals found — the checks below would be meaningless"


def test_deletes_on_expiry_not_on_revoked():
    """The whole point. A revoked row is evidence until it expires."""
    assert any("expires_at <" in s for s in _SQL), "the prune must select rows by expiry"
    for stmt in _SQL:
        assert not re.search(r"\brevoked\b", stmt, re.IGNORECASE), (
            f"a statement filters on `revoked`: {stmt!r}\n\n"
            "Deleting a revoked-but-unexpired row destroys the evidence that "
            "makes reuse detection work: the identical replay then reads as an "
            "unknown token rather than as theft, and the attacker's remaining "
            "family survives."
        )


def test_keeps_a_grace_period_past_expiry():
    """Nothing depends on it, but a session that failed a minute ago should
    still be visible to whoever is asked why."""
    assert prune.GRACE_HOURS >= 1, "no grace period past expiry"
    assert any("make_interval" in s for s in _SQL), "the grace period is not applied in SQL"


def test_deletes_in_bounded_batches():
    """A single DELETE would hold locks for minutes on the table every login
    depends on. Bounded batches with a commit between them compete for
    milliseconds instead."""
    assert 0 < prune.BATCH_SIZE <= 100_000, f"implausible batch size {prune.BATCH_SIZE}"
    assert any("LIMIT :lim" in s for s in _SQL), "the delete is not bounded per transaction"
    assert prune.MAX_BATCHES > 0, "no ceiling on a single run"


def test_run_is_bounded_by_max_batches():
    """A long-neglected table must not let one run monopolise the primary — the
    remainder is taken by the next run, and the overrun is logged rather than
    silently truncated."""
    assert "refresh_prune_hit_batch_ceiling" in _SOURCE, (
        "hitting the batch ceiling is not reported; a silently truncated prune "
        "looks identical to a completed one while the backlog keeps growing"
    )


def test_dry_run_counts_and_never_deletes():
    """The operator's safety valve: it must count, not delete."""
    # The `if dry_run:` block of run(), as an AST — same reasoning as
    # _sql_statements: the surrounding prose says "delete" repeatedly.
    run_fn = next(
        n
        for n in ast.walk(_TREE)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "run"
    )
    branch = next(
        n for n in run_fn.body if isinstance(n, ast.If)
    )
    stmts = _sql_statements(branch)
    assert stmts, "--dry-run issues no query at all"
    assert all("COUNT(*)" in s.upper() for s in stmts), f"--dry-run runs: {stmts}"
    assert not any(s.upper().startswith("DELETE") for s in stmts), (
        f"--dry-run reaches a DELETE: {stmts}"
    )

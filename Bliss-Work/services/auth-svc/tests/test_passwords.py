"""Argon2id password hashing contract (``app.security.passwords``).

Guards the invariants that let us raise Argon2 cost in prod safely:
  * hash/verify round-trips; wrong password and malformed hash -> False
  * dummy_verify() never raises (constant-time enumeration defence)
  * password policy (>=10 chars + letter + digit + special, not blocklisted)
  * a hash made with LOW params still verifies under the current (higher-cost)
    hasher — argon2 reads params from the stored hash, so raising cost never
    locks out existing users.

Skips cleanly if argon2/pydantic aren't installed in a bare local interpreter.
"""
from __future__ import annotations

import pytest

pw = pytest.importorskip(
    "app.security.passwords",
    reason="auth-svc deps (argon2/pydantic) not installed locally; CI installs requirements.txt.",
)


def test_hash_verify_roundtrip():
    h = pw.hash_password("S3cret!pass")
    assert h != "S3cret!pass"  # never store plaintext
    assert pw.verify_password(h, "S3cret!pass") is True


def test_wrong_password_rejected():
    h = pw.hash_password("S3cret!pass")
    assert pw.verify_password(h, "not-the-password") is False


def test_malformed_hash_rejected():
    assert pw.verify_password("not-a-real-argon2-hash", "x") is False


def test_dummy_verify_never_raises():
    pw.dummy_verify()  # constant-time miss path — must be silent


@pytest.mark.parametrize(
    "candidate,ok",
    [
        ("short!1", False),       # too short (<10)
        ("aaaaaaa!1", False),     # 9 chars — one short even with the class mix
        ("aaaaaaaaaa", False),    # 10 letters, no digit, no special
        ("abcdefghij1", False),   # 11 chars, letter+digit, NO special
        ("abcdefghij!", False),   # 11 chars, letter+special, NO digit
        ("1234567890!", False),   # digit+special, NO letter
        ("Abcd12345!", True),     # 10 chars, letter+digit+special
        ("Str0ng#Pass1", True),   # comfortably compliant
        ("password1!", False),    # meets the class rule but is blocklisted
        ("BlissWork1!", False),   # blocklisted app-name variant
        ("", False),
    ],
)
def test_password_policy(candidate, ok):
    assert pw.password_meets_policy(candidate) is ok


def test_policy_blocklist_is_case_insensitive():
    # Blocklist matches on lowercase, so any casing of a listed password fails.
    assert pw.password_meets_policy("PASSWORD1!") is False
    assert pw.password_meets_policy("Password1!") is False


def test_low_param_hash_still_verifies():
    argon2 = pytest.importorskip("argon2")
    low = argon2.PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)
    h = low.hash("S3cret!pass")
    # The current production hasher may use higher cost; verify must still succeed.
    assert pw.verify_password(h, "S3cret!pass") is True


# ── Event-loop safety ────────────────────────────────────────────────────────
#
# Argon2 is CPU-bound and this service runs uvicorn with ONE worker, so a
# synchronous hash on the event loop blocks every other request the pod is
# serving — health probes, token refreshes, everything — for its full duration.
# The login endpoint is unauthenticated, which makes that a way for anyone to
# consume the pod's only core.
#
# The failure is invisible without these: nothing errors, nothing logs, the pod
# just quietly serves a fraction of the traffic it should.


@pytest.mark.asyncio
async def test_sync_hashing_is_refused_on_the_event_loop():
    """The guard that makes the mistake impossible to make quietly."""
    for fn, args in (
        (pw.hash_password, ("S3cret!pass",)),
        (pw.verify_password, ("not-a-real-hash", "x")),
        (pw.dummy_verify, ()),
    ):
        with pytest.raises(RuntimeError, match="event loop"):
            fn(*args)


@pytest.mark.asyncio
async def test_async_forms_round_trip_off_the_loop():
    h = await pw.hash_password_async("S3cret!pass")
    assert h.startswith("$argon2")
    assert await pw.verify_password_async(h, "S3cret!pass") is True
    assert await pw.verify_password_async(h, "wrong") is False
    # The miss path must stay silent — it exists to equalise timing, and an
    # exception here would leak that the account does not exist.
    await pw.dummy_verify_async()


@pytest.mark.asyncio
async def test_hashing_does_not_block_the_event_loop():
    """The property the whole change exists for.

    While a hash is in flight the loop must still be able to run other work. If
    Argon2 ran inline, the sleep below could not be scheduled until it finished
    and the ordering would invert.
    """
    import asyncio

    order: list[str] = []

    async def hasher() -> None:
        await pw.hash_password_async("S3cret!pass")
        order.append("hash")

    async def other() -> None:
        # Far shorter than an Argon2 hash, so it must land first — unless the
        # loop was blocked, in which case it cannot run at all until the hash
        # completes.
        await asyncio.sleep(0.001)
        order.append("other")

    await asyncio.gather(hasher(), other())
    assert order == ["other", "hash"], (
        f"got {order}; the event loop was blocked for the duration of the hash"
    )


def test_sync_forms_still_work_off_the_loop():
    """Tests, scripts and the worker threads the async wrappers dispatch to."""
    h = pw.hash_password("S3cret!pass")
    assert pw.verify_password(h, "S3cret!pass") is True
    pw.dummy_verify()

"""Argon2id password hashing contract (``app.security.passwords``).

Guards the invariants that let us raise Argon2 cost in prod safely:
  * hash/verify round-trips; wrong password and malformed hash -> False
  * dummy_verify() never raises (constant-time enumeration defence)
  * password policy (>=8 chars + 1 special)
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
        ("short!", False),       # too short
        ("aaaaaaaa", False),     # long enough, no special char
        ("aaaaaaa!", True),      # 8 chars + special
        ("Str0ng#Pass", True),
        ("", False),
    ],
)
def test_password_policy(candidate, ok):
    assert pw.password_meets_policy(candidate) is ok


def test_low_param_hash_still_verifies():
    argon2 = pytest.importorskip("argon2")
    low = argon2.PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)
    h = low.hash("S3cret!pass")
    # The current production hasher may use higher cost; verify must still succeed.
    assert pw.verify_password(h, "S3cret!pass") is True

"""Pure-function TOTP/backup-code logic — no DB needed. The replay-safety
guarantee itself (the atomic FOR UPDATE check-then-update, and the
concurrent-race proof) lives in tests/integration/test_mfa.py, since it is
only meaningful against a real Postgres row lock. See
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.
"""
from __future__ import annotations

import time

import pyotp

from app.routes.mfa_service import _totp_matching_counter, generate_backup_codes


def test_matches_the_current_code() -> None:
    secret = pyotp.random_base32()
    code = pyotp.TOTP(secret).now()
    counter = int(time.time()) // 30
    assert _totp_matching_counter(secret, code) == counter


def test_tolerates_one_step_of_clock_skew_either_side() -> None:
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    now_counter = int(time.time()) // 30
    earlier_code = totp.at(for_time=(now_counter - 1) * 30)
    later_code = totp.at(for_time=(now_counter + 1) * 30)
    assert _totp_matching_counter(secret, earlier_code) == now_counter - 1
    assert _totp_matching_counter(secret, later_code) == now_counter + 1


def test_rejects_a_code_outside_the_tolerance_window() -> None:
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    now_counter = int(time.time()) // 30
    stale_code = totp.at(for_time=(now_counter - 5) * 30)
    assert _totp_matching_counter(secret, stale_code) is None


def test_wrong_secret_never_matches() -> None:
    code = pyotp.TOTP(pyotp.random_base32()).now()
    assert _totp_matching_counter(pyotp.random_base32(), code) is None


def test_backup_codes_are_the_right_shape_and_unique() -> None:
    codes = generate_backup_codes()
    assert len(codes) == 10
    assert len(set(codes)) == 10
    for code in codes:
        assert len(code) == 11  # 5 hex + '-' + 5 hex
        assert code[5] == "-"


def test_totp_comparison_is_constant_time_and_tolerates_non_ascii(monkeypatch) -> None:
    """B-AUTH-9: the code is compared with `secrets.compare_digest`, not `==`.
    A non-ASCII submission must be a plain mismatch (compare_digest raises
    TypeError on non-ASCII *str*, which would turn it into a 500)."""
    from app.routes import mfa_service

    calls: list[tuple[bytes, bytes]] = []
    real = mfa_service.secrets.compare_digest

    def _spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(mfa_service.secrets, "compare_digest", _spy)
    secret = pyotp.random_base32()

    assert _totp_matching_counter(secret, pyotp.TOTP(secret).now()) == int(time.time()) // 30
    assert calls, "TOTP candidates must be compared with secrets.compare_digest"
    assert _totp_matching_counter(secret, "12345é") is None

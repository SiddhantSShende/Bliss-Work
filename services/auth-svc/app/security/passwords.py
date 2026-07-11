"""Argon2id password hashing with constant-time dummy verify."""
from __future__ import annotations

import re

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

from ..config import settings


def _build_hasher() -> PasswordHasher:
    """Argon2id hasher. Cost params are env-tunable (0 = argon2-cffi default) so a
    deployment can raise them as hardware allows without a code change. verify()
    transparently re-checks against whatever params a stored hash was made with,
    so raising these never breaks existing logins."""
    kw: dict[str, int] = {}
    if settings.argon2_time_cost > 0:
        kw["time_cost"] = settings.argon2_time_cost
    if settings.argon2_memory_kib > 0:
        kw["memory_cost"] = settings.argon2_memory_kib
    if settings.argon2_parallelism > 0:
        kw["parallelism"] = settings.argon2_parallelism
    return PasswordHasher(**kw)


_hasher = _build_hasher()

# Password policy (mirrored client-side in lib/password.ts): >= 10 chars with a
# letter, a digit AND a special character, and not on a small blocklist of
# passwords that pass the character-class check but top every breach corpus.
# The server is the source of truth — the client meter mirrors it for UX only.
MIN_PASSWORD_LENGTH = 10
_SPECIAL_RE = re.compile(r"""[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?`~]""")
_LETTER_RE = re.compile(r"[A-Za-z]")
_DIGIT_RE = re.compile(r"[0-9]")
PASSWORD_POLICY_MESSAGE = (
    "Password must be at least 10 characters and include a letter, a number, "
    "and a special character."
)

# Lowercased exact-match blocklist: passwords that satisfy the class rule but are
# trivially guessable (top breach entries + obvious app-name variants). Kept small
# and embedded; a full breached-password (HIBP k-anonymity) check is a later add.
_COMMON_PASSWORDS = frozenset(
    {
        "password1!", "password1@", "password12!", "password123!", "password!1",
        "passw0rd!", "p@ssw0rd1", "p@ssword1!", "qwerty123!", "qwerty1234!",
        "welcome123!", "welcome1234", "admin12345!", "letmein123!", "iloveyou1!",
        "abc123456!", "changeme12!", "blisswork1!", "blisswork123", "trustno1!",
    }
)


def password_meets_policy(password: str) -> bool:
    pw = password or ""
    if len(pw) < MIN_PASSWORD_LENGTH:
        return False
    if not (_LETTER_RE.search(pw) and _DIGIT_RE.search(pw) and _SPECIAL_RE.search(pw)):
        return False
    return pw.lower() not in _COMMON_PASSWORDS

# Precomputed hash of a random secret, used to spend ~equal time on misses so
# login does not leak whether a user exists (enumeration defense).
_DUMMY_HASH = _hasher.hash("dummy-password-for-constant-time-verify")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def dummy_verify() -> None:
    """Burn equivalent CPU when the user/org is not found."""
    try:
        _hasher.verify(_DUMMY_HASH, "wrong-password")
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        pass

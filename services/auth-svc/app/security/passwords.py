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

# Password policy (mirrored client-side in the web app): >= 8 chars + 1 special.
_SPECIAL_RE = re.compile(r"""[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?`~]""")
PASSWORD_POLICY_MESSAGE = "Password must be at least 8 characters and include a special character."


def password_meets_policy(password: str) -> bool:
    return len(password or "") >= 8 and bool(_SPECIAL_RE.search(password or ""))

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

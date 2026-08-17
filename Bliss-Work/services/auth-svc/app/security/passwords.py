"""Argon2id password hashing with constant-time dummy verify.

── Why every public function here has an async twin ─────────────────────────
Argon2id is deliberately expensive: that slowness is the security property, and
raising the cost parameters is how you keep it ahead of the hardware an attacker
has. It is also, for the same reason, the single most CPU-expensive thing this
service does.

The route handlers are `async def`, and this service runs uvicorn with ONE
worker — one event loop per pod. A synchronous Argon2 call from a handler
therefore does not merely make that request slow, it blocks the event loop for
its entire duration, stalling every other request the pod is serving: health
probes, token refreshes, directory reads, all of them, queued behind a password
hash. Worse, the login endpoint is unauthenticated, so it hands anyone a way to
consume the pod's only core.

So the work is pushed to a thread. `asyncio.to_thread` is the right tool
precisely because Argon2 is CPU-bound C code that releases the GIL — the thread
genuinely runs in parallel rather than fighting the interpreter for it.

── The guard, and why it raises ─────────────────────────────────────────────
The synchronous functions REFUSE to run on an event loop. That is deliberate and
slightly unusual, so it is worth saying why: the failure this prevents is
invisible. A sync call from a handler is not a crash or an error, it is a pod
that quietly serves a fraction of the traffic it should, and no metric points at
the cause. Raising turns a silent, diffuse performance loss into an immediate,
obvious error at the one call site responsible.

The sync forms remain the API for anything genuinely off the loop — tests,
scripts, and the worker threads the async wrappers dispatch to.
"""
from __future__ import annotations

import asyncio
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


def _refuse_on_event_loop(fn: str) -> None:
    """Raise if called from a coroutine. See the module docstring.

    `get_running_loop` raises RuntimeError when there is no loop, which is the
    ordinary case for a test, a script, or the worker thread that
    `asyncio.to_thread` dispatches to — so the check is a no-op everywhere it
    should be.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError(
        f"{fn}() was called on the event loop. Argon2 is CPU-bound and this "
        f"service runs one worker, so a synchronous call here blocks every "
        f"other request the pod is serving. Use {fn}_async() instead."
    )


def hash_password(password: str) -> str:
    _refuse_on_event_loop("hash_password")
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    _refuse_on_event_loop("verify_password")
    try:
        return _hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def dummy_verify() -> None:
    """Burn equivalent CPU when the user/org is not found."""
    _refuse_on_event_loop("dummy_verify")
    try:
        _hasher.verify(_DUMMY_HASH, "wrong-password")
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        pass


# ── Async forms: what request handlers use ───────────────────────────────────
#
# Named distinctly rather than shadowing the sync versions, and that choice is
# load-bearing. If `verify_password` were simply made async, a call site that
# lost its `await` would return a coroutine object — which is TRUTHY — so
# `if not verify_password(...)` would silently evaluate to False and accept any
# password. A separate name means a missed conversion keeps the old blocking
# behaviour and trips the guard above, which is loud and harmless, rather than
# opening an authentication bypass.


async def hash_password_async(password: str) -> str:
    return await asyncio.to_thread(_hasher.hash, password)


async def verify_password_async(stored_hash: str, password: str) -> bool:
    def _verify() -> bool:
        try:
            return _hasher.verify(stored_hash, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    return await asyncio.to_thread(_verify)


async def dummy_verify_async() -> None:
    """Burn equivalent CPU when the user/org is not found.

    Offloaded like the others: this exists to make a miss cost the same as a hit,
    so running it on the loop while the hit runs on a thread would defeat the
    point twice over — it would block, AND the timings would no longer match.
    """

    def _burn() -> None:
        try:
            _hasher.verify(_DUMMY_HASH, "wrong-password")
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            pass

    await asyncio.to_thread(_burn)

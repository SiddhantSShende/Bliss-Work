"""Connection verification — the code round trip that turns 'pending' into 'connected'.

Used by WhatsApp today. Validating credentials only proves we can read the
business number's metadata; this proves a message actually travelled
BlissWork → Meta → the admin's phone (or came back the other way).

Storage rules, copied from auth-svc's password-reset / email-verify tokens
(services/auth-svc/app/routes/account_service.py):

  * Only the SHA-256 is persisted, never the code.
  * The digest is over "{connection_id}:{code}" — a 6-digit space is tiny, and
    per-connection salting stops one precomputed table covering every row.
  * Comparison is constant-time.
  * Single-use, TTL'd, and attempt-capped, because six digits is guessable in a
    few hundred thousand tries and only the cap makes that expensive.

The caller owns the transaction; nothing here commits.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass

from sqlalchemy import text

from .crypto import cryptor

#: How long a code stays usable. Long enough to go find your phone, short enough
#: that an abandoned setup doesn't leave a live code lying around.
TTL_MINUTES = 10
#: Wrong guesses allowed before the code is dead and must be re-sent.
MAX_ATTEMPTS = 5
#: Minimum gap between sends, so "Resend" can't be used to bomb a phone number
#: (every send costs the org money at Meta, too).
RESEND_COOLDOWN_SECONDS = 60

#: What the admin sends to the business number when we can't message them first.
#: Matched case-insensitively, and tolerant of the separator being eaten by a
#: keyboard's autocorrect ("confirm 482193" is the same intent).
REPLY_PREFIX = "CONFIRM"
_REPLY_RE = re.compile(rf"{REPLY_PREFIX}[\s\-:_]*(\d{{6}})", re.IGNORECASE)


class VerificationError(Exception):
    """A definitive failure the caller should surface to the user."""


class ResendTooSoon(VerificationError):
    """A code was sent moments ago; wait for the cooldown."""


class TooManyAttempts(VerificationError):
    """The attempt cap is spent — the code is dead, re-send to get a new one."""


@dataclass(frozen=True)
class Verification:
    code: str
    #: The literal string to send to the business number when outbound delivery
    #: isn't possible (no open 24h session and no approved template).
    reply_keyword: str


def _hash(connection_id: str, code: str) -> bytes:
    return hashlib.sha256(f"{connection_id}:{code}".encode("utf-8")).digest()


def new_code() -> str:
    """A 6-digit code, zero-padded. `randbelow` (not `random`) — this is a secret."""
    return f"{secrets.randbelow(1_000_000):06d}"


def extract_reply_code(body: str) -> str | None:
    """Pull the code out of an inbound 'CONFIRM 482193' message, or None."""
    m = _REPLY_RE.search(body or "")
    return m.group(1) if m else None


async def mint(db, org_id: str, connection_id: str, target: str) -> Verification:
    """Issue a fresh code for `connection_id`, replacing any outstanding one.

    Raises ResendTooSoon if the previous code was sent inside the cooldown, so a
    held-down Resend button can't be turned into an SMS-bomb of someone's phone.
    """
    existing = (
        await db.execute(
            text(
                """
                SELECT last_sent_at,
                       last_sent_at > now() - make_interval(secs => :cd) AS too_soon
                  FROM connection_verifications
                 WHERE connection_id = :c AND confirmed_at IS NULL
                """
            ),
            {"c": connection_id, "cd": RESEND_COOLDOWN_SECONDS},
        )
    ).one_or_none()
    if existing is not None and existing.too_soon:
        raise ResendTooSoon("a code was just sent — wait a moment before trying again")

    code = new_code()
    await db.execute(
        text(
            """
            INSERT INTO connection_verifications
                (connection_id, org_id, code_hash, target_enc, attempts,
                 last_sent_at, expires_at)
            VALUES
                (:c, :o, :h, :t, 0, now(), now() + make_interval(mins => :ttl))
            ON CONFLICT (connection_id) DO UPDATE SET
                code_hash    = EXCLUDED.code_hash,
                target_enc   = EXCLUDED.target_enc,
                -- A re-send is a clean slate: the old code is gone, so the old
                -- failed guesses shouldn't keep counting against the new one.
                attempts     = 0,
                last_sent_at = now(),
                expires_at   = EXCLUDED.expires_at,
                confirmed_at = NULL
            """
        ),
        {
            "c": connection_id,
            "o": org_id,
            "h": _hash(connection_id, code),
            "t": await cryptor().encrypt(db, org_id, target),
            "ttl": TTL_MINUTES,
        },
    )
    return Verification(code=code, reply_keyword=f"{REPLY_PREFIX} {code}")


async def consume(db, connection_id: str, code: str) -> bool:
    """Check `code` and, on a match, mark the verification confirmed.

    Returns False for a wrong/expired code. Raises TooManyAttempts once the cap
    is spent. Single-use: a second call with the same (correct) code returns
    False, because the row is no longer unconfirmed.
    """
    row = (
        await db.execute(
            text(
                """
                SELECT code_hash, attempts, expires_at <= now() AS expired
                  FROM connection_verifications
                 WHERE connection_id = :c AND confirmed_at IS NULL
                 FOR UPDATE
                """
            ),
            {"c": connection_id},
        )
    ).one_or_none()
    if row is None:
        return False
    if row.attempts >= MAX_ATTEMPTS:
        raise TooManyAttempts("too many incorrect codes — send a new one")
    if row.expired:
        return False

    if not secrets.compare_digest(bytes(row.code_hash), _hash(connection_id, code)):
        # Count the miss BEFORE returning, or the cap is decorative.
        await db.execute(
            text(
                "UPDATE connection_verifications SET attempts = attempts + 1 "
                "WHERE connection_id = :c"
            ),
            {"c": connection_id},
        )
        return False

    await db.execute(
        text(
            "UPDATE connection_verifications SET confirmed_at = now() "
            "WHERE connection_id = :c AND confirmed_at IS NULL"
        ),
        {"c": connection_id},
    )
    return True


async def confirm_connection(db, connection_id: str) -> None:
    """Promote a verified connection to 'connected' — the point of all of this.

    Guarded on 'pending' so this can never resurrect a connection the user
    revoked while a code was in flight.
    """
    await db.execute(
        text(
            """
            UPDATE integration_connections
               SET status = 'connected', last_error = NULL, updated_at = now()
             WHERE id = :c AND status = 'pending'
            """
        ),
        {"c": connection_id},
    )

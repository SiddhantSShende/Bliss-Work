"""POST /internal/mail/send must send a given mail_id through the provider AT
MOST ONCE, no matter how many times it is asked — a Kafka redelivery after
email-worker lost the result, two workers racing the same event, or a
deliberate retry after a genuine failure.

These go through the real FastAPI route and a real Postgres (the claim is a
unique-constraint INSERT under real concurrency — see 0013_mail_send_idempotency.sql
and internal.py's _claim_mail_send). Only providers.microsoft.send_mail itself
is replaced, so no real Graph call is ever made.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
USER = "22222222-2222-2222-2222-222222222222"
MAIL_A = "018f0000-0000-7000-8000-0000000000aa"
MAIL_B = "018f0000-0000-7000-8000-0000000000bb"
TOKEN = "test-internal-token"


async def _seed_connection(org_id: str = ORG, user_id: str = USER) -> None:
    """A connected Outlook mailbox for `user_id` — the row internal_send_mail
    looks up before it ever reaches the idempotency claim."""
    from sqlalchemy import text

    from crypto import cryptor
    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, org_id)
        access_enc = await cryptor().encrypt(db, org_id, "fake-access-token")
        await db.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider,
                     status, display_label, access_token_enc)
                VALUES
                    (gen_random_uuid(), :o, :u, :u, 'user', 'outlook',
                     'connected', 'work outlook', :a)
                """
            ),
            {"o": org_id, "u": user_id, "a": access_enc},
        )
        await db.commit()


def _mail_send_body(mail_id: str, **overrides: object) -> dict:
    body = {
        "orgId": ORG,
        "userId": USER,
        "mailId": mail_id,
        "subject": "Q3 numbers",
        "bodyText": "Deck attached.",
        "to": ["partner@outside.test"],
    }
    body.update(overrides)
    return body


async def _client() -> httpx.AsyncClient:
    from app.main import app

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def _internal_token(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "internal_token", TOKEN)


class _RecordingSend:
    """Stands in for providers.microsoft.send_mail. `outcomes` lets a test
    script a different result per call (e.g. fail then succeed)."""

    def __init__(self, outcomes=None, delay: float = 0.0) -> None:
        self.calls: list[dict] = []
        self._outcomes = list(outcomes) if outcomes is not None else None
        self._delay = delay

    async def __call__(self, token: str, **kwargs: object) -> None:
        self.calls.append({"token": token, **kwargs})
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._outcomes:
            outcome = self._outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome


def _install(monkeypatch, send):
    from app.routes import internal as internal_routes

    monkeypatch.setattr(internal_routes.ms, "send_mail", send)


# ── Test 1: Kafka redelivery (the exact same request, twice) ────────────────


async def test_redelivering_the_same_event_sends_through_the_provider_once(db_app, monkeypatch):
    await _seed_connection()
    send = _RecordingSend()
    _install(monkeypatch, send)

    async with await _client() as c:
        r1 = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
        r2 = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert r2.json() == {"status": "sent", "provider": "outlook"}
    assert len(send.calls) == 1


# ── Test 2: DB failure recording the outcome must not cause a resend ────────


async def test_a_lost_result_never_causes_a_second_send_on_redelivery(db_app, monkeypatch):
    """Simulates relay_consumer.py's own scenario: the provider send succeeded
    but the caller never learned it (the response was lost, or — in
    email-worker's case — _record_transport failed after this call returned).
    The NEXT call for the same mail_id must still see it as already sent."""
    await _seed_connection()
    send = _RecordingSend()
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
        assert first.status_code == 200
        # The caller "lost" that response (its own DB write failed) and, per
        # its own resilience contract, redelivers the event from scratch.
        second = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    assert second.status_code == 200
    assert len(send.calls) == 1


# ── Test 3: real concurrency — two requests racing the same mail_id ─────────


async def test_two_concurrent_requests_for_the_same_mail_send_exactly_once(db_app, monkeypatch):
    await _seed_connection()
    # A small delay widens the window the two requests' claims can overlap in,
    # so this actually exercises the race instead of the second one always
    # landing after the first has already resolved.
    send = _RecordingSend(delay=0.05)
    _install(monkeypatch, send)

    async with await _client() as c:
        r1, r2 = await asyncio.gather(
            c.post(
                "/internal/mail/send",
                json=_mail_send_body(MAIL_A),
                headers={"X-Internal-Token": TOKEN},
            ),
            c.post(
                "/internal/mail/send",
                json=_mail_send_body(MAIL_A),
                headers={"X-Internal-Token": TOKEN},
            ),
        )

    assert len(send.calls) == 1
    statuses = sorted([r1.status_code, r2.status_code])
    # The winner sends (200); the loser sees the claim in progress (409) — it
    # is the caller's job to retry later, exactly like any other transient
    # answer from this endpoint, not this endpoint's job to make it wait. Not
    # 503: provider_mail.py's breaker would count a 5xx as "integrations-svc
    # is unhealthy" and, after enough of them, fall back to relaying a mail
    # that may already be on its way through the winner.
    assert statuses == [200, 409]


# ── Test 4: different mails must never be deduplicated against each other ───


async def test_two_different_mail_ids_both_send(db_app, monkeypatch):
    await _seed_connection()
    send = _RecordingSend()
    _install(monkeypatch, send)

    async with await _client() as c:
        r1 = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
        r2 = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_B), headers={"X-Internal-Token": TOKEN}
        )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert len(send.calls) == 2


# ── Test 5: a genuine failure must not block a legitimate retry ─────────────


async def test_a_definitive_failure_can_be_retried_and_then_succeeds(db_app, monkeypatch):
    from app.providers import microsoft as ms

    await _seed_connection()
    send = _RecordingSend(outcomes=[ms.MicrosoftError("attachments too large"), None])
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
        assert first.status_code == 400  # definitive — the caller relays over SMTP

        second = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    assert second.status_code == 200
    assert len(send.calls) == 2


# ── Test 6: an already-sent mail replays the result, never calls the provider


async def test_an_already_sent_mail_replays_without_calling_the_provider(db_app, monkeypatch):
    await _seed_connection()
    send = _RecordingSend()
    _install(monkeypatch, send)

    async with await _client() as c:
        await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
        assert len(send.calls) == 1

        replay = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    assert replay.status_code == 200
    assert replay.json() == {"status": "sent", "provider": "outlook"}
    assert len(send.calls) == 1  # still one — this call never reached send_mail


# ── Regression: an ambiguous network fault must not leave the mail resendable


async def test_an_ambiguous_network_fault_leaves_the_claim_in_place(db_app, monkeypatch):
    """The one case 0013's docstring calls unsolvable: the provider call
    itself times out. The claim must NOT be released — a redelivery must keep
    answering 409, never silently resend a mail that may already be sitting in
    the recipient's inbox.

    409, not 502/503: those are the statuses provider_mail.py's shared breaker
    counts as "integrations-svc is unhealthy" and, once enough of them
    accumulate, answers False (fall back to the relay) — which for a claim
    stuck like this means a genuine duplicate on top of whatever Graph
    already did. See test_provider_mail.py's equivalent regression test on
    the caller's side.
    """
    await _seed_connection()
    send = _RecordingSend(outcomes=[httpx.ReadTimeout("simulated timeout")])
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
        assert first.status_code == 409

        redelivered = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    assert redelivered.status_code == 409  # still claimed — not retried
    assert len(send.calls) == 1  # never called a second time


# ── Regression: a DB hiccup recording the outcome must not strand the claim ──


async def test_a_transient_db_hiccup_recording_the_outcome_is_retried_and_succeeds(
    db_app, monkeypatch
):
    """_resolve_mail_send's own commit (the write that follows the provider
    call) must absorb a passing DB blip the same way _claim_mail_send's own
    commit-boundary is guarded, instead of leaving the row stuck 'sending' —
    see internal.py's _resolve_mail_send docstring and 0013's docstring on
    what a stuck row costs (a manual SQL fix, and a safe-to-retry mail that
    can never be retried).
    """
    from sqlalchemy.ext.asyncio import AsyncSession

    await _seed_connection()
    send = _RecordingSend()
    _install(monkeypatch, send)

    real_commit = AsyncSession.commit
    calls = {"n": 0}

    async def flaky_commit(self, *a, **kw):
        calls["n"] += 1
        # Call 1 is _claim_mail_send's own commit — it must succeed, or this
        # request never reaches the provider call this test is about. Call 2
        # is _resolve_mail_send's FIRST attempt; failing only that one proves
        # its retry loop, not a fluke of the real DB never failing anyway.
        if calls["n"] == 2:
            raise OSError("simulated connection drop")
        return await real_commit(self, *a, **kw)

    monkeypatch.setattr(AsyncSession, "commit", flaky_commit)

    async with await _client() as c:
        r = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    assert r.status_code == 200, r.text
    assert len(send.calls) == 1  # the hiccup was absorbed, not retried as a resend
    assert calls["n"] == 3  # claim's commit, the failed attempt, the retry that succeeded

    # The outcome actually landed — a redelivery replays it rather than
    # re-claiming or erroring, exactly like the non-flaky replay test above.
    async with await _client() as c:
        replay = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
    assert replay.status_code == 200
    assert replay.json() == {"status": "sent", "provider": "outlook"}
    assert len(send.calls) == 1


async def test_a_persistent_db_failure_resolving_a_failed_outcome_surfaces_and_leaves_the_row_stuck(
    db_app, monkeypatch
):
    """The failure this pins: before the fix, an exception out of
    _resolve_mail_send's unguarded commit was indistinguishable from any other
    unhandled error, AND — because nothing retried it — a DB hiccup that would
    have cleared up on its own permanently stranded the row 'sending', which
    for a 'failed' outcome means a mail the provider genuinely rejected can
    never be reclaimed and retried again.

    After the fix: a run of failures that outlasts the retry budget must still
    surface loudly (never a silent 200/400 that lies about what got
    persisted) and must leave the mail_send_attempts row in the SAME
    documented, safe 'sending' state 0013's docstring already accepts for the
    ambiguous-network-fault case — not corrupted, not double-sendable, just
    stuck pending a manual fix.
    """
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.providers import microsoft as ms

    await _seed_connection()
    send = _RecordingSend(outcomes=[ms.MicrosoftError("attachments too large")])
    _install(monkeypatch, send)

    real_commit = AsyncSession.commit
    calls = {"n": 0}

    async def flaky_commit(self, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            # _claim_mail_send's own commit — must succeed, or the route
            # never reaches the provider call at all.
            return await real_commit(self, *a, **kw)
        # Every attempt _resolve_mail_send makes fails: a persistent outage
        # that outlasts its retry budget, not a passing blip.
        raise OSError("simulated connection drop")

    monkeypatch.setattr(AsyncSession, "commit", flaky_commit)

    # raise_app_exceptions=False: Starlette's ServerErrorMiddleware sends the
    # unhandled-exception JSONResponse (500) exactly like it would to a real
    # caller, AND re-raises afterward purely so the ASGI server/test runner
    # can also log it (see Starlette's own docstring on that behavior). The
    # other tests in this file want that re-raise — it would fail THEM loudly
    # if a bug ever made this endpoint crash unexpectedly — but this test
    # deliberately induces the crash and needs the actual Response back.
    from app.main import app

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )

    # Must not look like the intended, definitive 400, and must not look like
    # success — the resolution genuinely failed to persist, and that failure
    # must be visible, not swallowed.
    assert r.status_code == 500
    assert len(send.calls) == 1  # the provider was still only asked once
    assert calls["n"] == 4  # the claim's commit + all 3 of _resolve_mail_send's attempts

    # A redelivery for the SAME mail_id must see the claim as still in
    # progress — 409, the same documented, safe outcome as the
    # ambiguous-network-fault regression above — never a silent second real
    # send and never a wrongly-replayed "sent"/"failed" result. This path
    # never reaches db.commit() at all (a losing _claim_mail_send INSERT reads
    # the existing row back and returns "in_progress" without committing), so
    # the still-failing patched commit above is never even exercised again —
    # confirming the redelivery is answered entirely from the state the first
    # request already left behind.
    async with await _client() as c:
        redelivered = await c.post(
            "/internal/mail/send", json=_mail_send_body(MAIL_A), headers={"X-Internal-Token": TOKEN}
        )
    assert redelivered.status_code == 409
    assert len(send.calls) == 1  # never called the provider a second time

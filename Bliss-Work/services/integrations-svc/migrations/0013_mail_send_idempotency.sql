-- 0013_mail_send_idempotency — exactly-once outbound mail through a connected mailbox.
--
-- ── The failure this closes ──────────────────────────────────────────────────
-- POST /internal/mail/send had no idempotency key at all: it called
-- providers.microsoft.send_mail unconditionally on every execution. email-worker
-- (relay_consumer.py) can call it more than once for the SAME mail — a Kafka
-- redelivery after _record_transport failed to persist a successful send, or a
-- process crash between the provider accepting the message and the caller
-- learning that — and every one of those was a second real email through the
-- member's own mailbox, landing twice on every recipient and twice in the
-- member's own Sent folder.
--
-- ── Why mail_id is the key ───────────────────────────────────────────────────
-- mail_id is messaging-svc's primary key for the mail (see mail_messages),
-- generated once when the member hits Send and carried unchanged on every copy
-- of the mail.outbound event and every retry/redelivery of it — exactly the
-- "same Kafka event -> same key" identity idempotency needs, already unique and
-- already stable, so no separate idempotency_key had to be invented.
--
-- ── The state machine ────────────────────────────────────────────────────────
-- 'sending' — claimed, provider not yet confirmed one way or the other.
-- 'sent'    — the provider accepted it; replay this result, never call again.
-- 'failed'  — the provider definitively refused (or never received) the
--             request; a later attempt is safe to reclaim this row and retry.
--
-- A row that STAYS 'sending' means the worker lost the provider's answer
-- (a timeout/connection error on the sendMail call itself, or a crash before
-- the UPDATE below committed) — the one case this table cannot resolve on its
-- own: the message may or may not have gone out. Reclaiming it automatically
-- would risk a genuine duplicate; routes/internal.py therefore leaves it
-- claimed and answers 409 (Conflict) to every further attempt rather than
-- guessing. 409, deliberately not 502/503: those are the codes email-worker's
-- provider_mail.py breaker treats as "integrations-svc is unhealthy" and,
-- once enough accumulate, answers with a fall-back-to-relay False — which for
-- a stuck mail_id means a genuine duplicate send through the SMTP relay on
-- top of whatever Graph already did. A 409 is never transient to that
-- breaker, so a stuck row can never trip it. See the idx_mail_send_attempts_
-- stuck index below and internal_send_mail's docstring — clearing a stuck row
-- for a manual retry is an operator action (UPDATE mail_send_attempts SET
-- status = 'failed' WHERE mail_id = ... after checking the mailbox's own Sent
-- folder), not something this migration automates.

CREATE TABLE IF NOT EXISTS mail_send_attempts (
    mail_id    uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    status     text NOT NULL DEFAULT 'sending'
                 CHECK (status IN ('sending', 'sent', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT apply_org_isolation('mail_send_attempts');

-- Finds rows an operator needs to look at by hand — see the state-machine note
-- above. Partial on the one status that can never resolve itself.
CREATE INDEX IF NOT EXISTS idx_mail_send_attempts_stuck
    ON mail_send_attempts (created_at)
    WHERE status = 'sending';

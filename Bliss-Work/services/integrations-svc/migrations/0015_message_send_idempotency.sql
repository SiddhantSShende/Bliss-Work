-- 0015_message_send_idempotency — exactly-once outbound Slack/Teams/Gmail chat
-- forward through a connected integration.
--
-- ── Why this exists ahead of a caller ────────────────────────────────────────
-- POST /internal/messages/send (internal_send) called outbound.send_via_connection
-- unconditionally on every execution, with no claim/dedup table — unlike its
-- sibling POST /internal/mail/send, which got exactly this treatment in
-- 0013_mail_send_idempotency.sql after a Kafka redelivery there could produce a
-- duplicate outbound email. Nothing calls /internal/messages/send today — see
-- internal.py's module docstring; messaging-svc's outbound-to-external forward
-- for Bliss-Work messages is not wired up yet — so this endpoint carries no live
-- duplicate-send risk right now. This migration adds the same protection ahead
-- of that caller existing, so the day a Kafka-redelivered forward event does
-- reach this endpoint, it can never produce a duplicate Slack/Teams message or
-- duplicate Gmail send — the same failure mode 0013's docstring describes for
-- mail, pre-empted here instead of fixed after an incident.
--
-- ── Why message_id is the key ────────────────────────────────────────────────
-- message_id is the Bliss-Work message being forwarded — stable across every
-- copy of the same forward event and every retry/redelivery of it, exactly the
-- "same Kafka event -> same key" identity idempotency needs. Mirrors mail_id's
-- role in 0013 exactly (see that migration's "Why mail_id is the key" section)
-- — no separate idempotency_key had to be invented here either.
--
-- ── The state machine ────────────────────────────────────────────────────────
-- Identical to mail_send_attempts (see 0013's docstring for the full
-- rationale):
-- 'sending' — claimed, provider not yet confirmed one way or the other.
-- 'sent'    — the provider accepted it; replay this result, never call again.
-- 'failed'  — the provider definitively refused (or never received) the
--             request; a later attempt is safe to reclaim this row and retry.
--
-- A row that STAYS 'sending' means the caller lost the provider's answer (a
-- timeout/connection error on the send call itself, or a crash before the
-- resolving UPDATE committed) — routes/internal.py leaves it claimed and
-- answers 409 (Conflict) to every further attempt rather than guessing, same
-- as mail. See internal_send's docstring and _claim_message_send for the rest.

CREATE TABLE IF NOT EXISTS message_send_attempts (
    message_id uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    status     text NOT NULL DEFAULT 'sending'
                 CHECK (status IN ('sending', 'sent', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT apply_org_isolation('message_send_attempts');

-- Finds rows an operator needs to look at by hand — see the state-machine note
-- above. Partial on the one status that can never resolve itself.
CREATE INDEX IF NOT EXISTS idx_message_send_attempts_stuck
    ON message_send_attempts (created_at)
    WHERE status = 'sending';

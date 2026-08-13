-- 0001_init.sql ─ Phase 6 offline-relay durable dedup.
--
-- Lives in emaildb — email-worker's OWN database (strict database-per-service).
-- Recipient e-mail/username are resolved via auth-svc's internal API, so the
-- worker no longer reads from any other service's database.
--
-- Two-phase state: pending → sent. A row inserted with state='pending' is the
-- worker's claim ticket; after SMTP succeeds it is updated to 'sent'. A reaper
-- (in relay_consumer.py) periodically retries rows still 'pending' older than
-- 30s — covers the case where the worker crashed between INSERT and SMTP.
CREATE TABLE IF NOT EXISTS email_consumed (
    event_id     uuid       NOT NULL,
    recipient_id uuid       NOT NULL,
    state        text       NOT NULL CHECK (state IN ('pending', 'sent')),
    consumed_at  timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz,
    PRIMARY KEY (event_id, recipient_id)
);

-- Reaper index for the "retry pending older than 30s" sweep.
CREATE INDEX IF NOT EXISTS idx_email_consumed_pending_age
    ON email_consumed (consumed_at)
    WHERE state = 'pending';

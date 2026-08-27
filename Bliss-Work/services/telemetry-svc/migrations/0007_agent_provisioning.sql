-- 0007_agent_provisioning — idempotent auto-provisioning + health reporting
-- for paired agents (desktop sampler, browser extension).
--
-- Automatic provisioning means a login can call POST /tokens on every launch
-- without minting a fresh secret each time. `device_key` is a stable id the
-- CLIENT generates once per installation and persists locally (never
-- server-generated, so the server cannot "adopt" a device it never actually
-- talked to) — a repeat call with the same (org, user, kind, device_key)
-- returns the existing row instead of a new one. Existing/manual tokens have
-- device_key NULL and are untouched: the partial index below only constrains
-- rows that opt into this, so today's "many desktops per person" flow (no
-- device_key supplied) keeps minting a fresh row every click, same as before.
ALTER TABLE ingest_tokens ADD COLUMN IF NOT EXISTS device_key    text;

-- last_seen_at: the credential was proven to work (an ingest OR a status
-- ping). last_used_at: it actually carried real activity. Kept distinct on
-- purpose — collapsing them would make "paired but not yet tracking" and
-- "tracking" indistinguishable, which is exactly the confirmation gap the
-- provisioning state machine (NOT_INSTALLED..TRACKING_ACTIVE) exists to close.
ALTER TABLE ingest_tokens ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz;
ALTER TABLE ingest_tokens ADD COLUMN IF NOT EXISTS agent_version text;
ALTER TABLE ingest_tokens ADD COLUMN IF NOT EXISTS platform      text;

-- Defense-in-depth, not the primary idempotency guard (that's the client only
-- calling provision when it holds no local token). Catches a genuine
-- double-submit race — e.g. a retried provisioning call after a lost
-- response — the same role migration 0006's client_event_id index plays for
-- activity_events.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_tokens_device
    ON ingest_tokens (org_id, user_id, kind, device_key)
    WHERE revoked_at IS NULL AND device_key IS NOT NULL;

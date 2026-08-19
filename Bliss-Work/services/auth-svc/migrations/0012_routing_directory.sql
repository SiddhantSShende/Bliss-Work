-- 0012_routing_directory.sql — where each org and each invite lives.
--
-- Org data is partitioned by site and never replicated: an organisation has one
-- home site, decided at signup, and stays there. What IS replicated to every
-- site is this DIRECTORY — a small key→site map, kept in step through the
-- region bridge — so that any site can answer "where does this belong?" from a
-- LOCAL read. That local-read property is the point: a cross-site query on the
-- request path is the thing this design exists to avoid.
--
-- ── Why one table for two kinds of key ───────────────────────────────────────
--
-- An org-scoped request that reaches the wrong site, and an invite redemption
-- that cannot know its org at all, are the same question asked with different
-- keys. RedeemInvite looks up by token_hash ALONE and deliberately so — an
-- invite link has to work before the recipient belongs to anything — so it has
-- no org id to route by and needs the token itself to be routable. One table,
-- one lookup, one redirect helper; they were two code paths once and the second
-- one was always the one that got it wrong.
--
-- ── No RLS, on purpose ───────────────────────────────────────────────────────
--
-- Every other table here is org-isolated. This one cannot be: it is read BEFORE
-- any org context exists — that is its entire job — so an org_isolation policy
-- would make every lookup return nothing and every request answer "not
-- replicated yet, retry", forever. It follows `identities` and `refresh_tokens`
-- (0003, 0007), which are cross-org for the same reason.
--
-- What that costs is worth stating: this table is readable by any trusted
-- database caller. It holds no personal data and no secrets — an org id, a
-- token HASH, and a site name — and the token hash is already the stored form of
-- a credential this service holds anyway.

CREATE TABLE IF NOT EXISTS routing_directory (
    -- 'org'    → key_value is an organisation id
    -- 'invite' → key_value is sha256(raw invite token), the same hash `invites`
    --            stores, so a redemption can look here with what it already has
    key_type    text NOT NULL CHECK (key_type IN ('org', 'invite')),
    key_value   text NOT NULL,

    home_site   text NOT NULL,

    -- Invites only. Orgs never expire and are never revoked: an org has exactly
    -- one home for its lifetime, so there is nothing either column could mean.
    expires_at  timestamptz,
    revoked_at  timestamptz,

    created_at  timestamptz NOT NULL DEFAULT now(),

    -- The VERSION, not a housekeeping timestamp: it is the event's occurredAt,
    -- and an incoming event is applied only if it is at least as new. That is
    -- what makes the consumer safe under the bridge's at-least-once delivery —
    -- a replay, a redelivery, or a revoke that overtakes its own upsert all
    -- converge on the same row rather than fighting over it.
    updated_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (key_type, key_value)
);

-- The only read on the request path, and it is the primary key: (key_type,
-- key_value) → home_site. Nothing else here is allowed to be slower than that.

-- Expiry sweep: invites outlive their usefulness by design (a 72h TTL), and
-- without a way to find them the directory grows one row per invite ever minted,
-- forever. Partial, because orgs have no expiry and must never be swept.
CREATE INDEX IF NOT EXISTS idx_routing_directory_expiry
    ON routing_directory (expires_at)
    WHERE expires_at IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- site_capacity — every site's storage position, as last reported by that site.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Placement has to compare sites, and comparing them by querying them would put
-- a cross-site round trip on the signup path — and make signup fail when a
-- remote site is unreachable. So each site publishes its own position onto the
-- bridged routing topic and every site keeps this local copy. Eventually
-- consistent, which is fine: placement is a capacity decision measured in days,
-- not a lock.
--
-- `reported_at` is load-bearing. A site that has stopped reporting has usually
-- stopped doing other things too, and a stale "40% full" is exactly how a
-- stream of new organisations gets routed into a dead site. The placement
-- policy treats anything older than its freshness window as UNKNOWN rather than
-- as its last value.
CREATE TABLE IF NOT EXISTS site_capacity (
    site           text PRIMARY KEY,
    used_bytes     bigint NOT NULL CHECK (used_bytes >= 0),
    -- The HARD ceiling for this site. Zero or negative reads as "full" in the
    -- policy rather than as "unlimited": an unconfigured site must not become
    -- the default destination for every new organisation.
    ceiling_bytes  bigint NOT NULL,
    reported_at    timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

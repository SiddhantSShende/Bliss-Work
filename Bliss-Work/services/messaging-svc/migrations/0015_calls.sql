-- 0015_calls.sql — scheduled calls, meetings, and cross-org meeting invites.
--
-- Calls previously had NO persistence at all: `callId` was a string minted by
-- the client and carried on an ephemeral signaling frame, so a call left no
-- record, could not be scheduled, and had no roster beyond the two sockets
-- involved. All three of the features this migration serves need a real entity:
--
--   CHANNEL  a call whose roster IS the channel's membership. No invite link
--            exists, by design — you are in the call because you are in the
--            channel, so there is nothing to hand out and nothing to revoke.
--   MEETING  a scheduled call with an EXPLICIT roster, joinable by link. The
--            link may be sent before it starts or while it is running, and the
--            person redeeming it may belong to a DIFFERENT ORG.
--   DIRECT   the ad-hoc call that already existed, now with a roster so a
--            participant can pull in another member of their own org mid-call.
--
-- ── The cross-org problem ────────────────────────────────────────────────────
-- Every other table in this database is org-isolated by RLS: a row is visible
-- iff its org_id equals the per-transaction app.org_id GUC. A MEETING breaks
-- that assumption on purpose — an invited participant from another org must see
-- the call row while their app.org_id is their OWN org.
--
-- Rather than weaken org isolation globally (or reach for app.bypass_rls, which
-- would switch the second wall off entirely for the whole request), these three
-- tables get a policy with ONE additional disjunct: you may also see a call you
-- are a participant of. That requires knowing who the caller IS, so this
-- migration introduces a second GUC, app.user_id, set alongside app.org_id.
--
-- The disjunct is deliberately NOT recursive: calls' policy subqueries
-- call_participants, and call_participants' policy contains no subquery at all.
-- Postgres applies RLS inside that subquery too, which is what makes it safe —
-- a cross-org caller sees only their OWN participant row there, so the EXISTS
-- reduces to "was I invited to this call", which is exactly the grant we want.
--
-- Idempotent throughout, matching 0007_rls.sql's guarded-policy pattern.

-- ── calls ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
    id            uuid PRIMARY KEY,
    -- The HOSTING org. For a MEETING this is the organiser's org, and
    -- participants from other orgs carry their own org_id on their
    -- call_participants row.
    org_id        uuid NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('DIRECT', 'CHANNEL', 'MEETING')),
    -- Set for CHANNEL calls only; the roster is derived from channel_members
    -- at ring time rather than copied, so leaving the channel leaves the call.
    channel_id    uuid,
    title         text NOT NULL DEFAULT '',
    media         text NOT NULL DEFAULT 'video' CHECK (media IN ('audio', 'video')),
    created_by    uuid NOT NULL,
    -- NULL = start immediately (an ad-hoc DIRECT call or "meet now").
    scheduled_at  timestamptz,
    started_at    timestamptz,
    ended_at      timestamptz,
    status        text NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (status IN ('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- A CHANNEL call must name its channel; a MEETING must not borrow one.
    CONSTRAINT calls_channel_kind CHECK (
        (kind = 'CHANNEL' AND channel_id IS NOT NULL)
        OR (kind <> 'CHANNEL' AND channel_id IS NULL)
    )
);

-- ── call_participants ────────────────────────────────────────────────────────
-- Explicit roster. For CHANNEL calls this holds only those who actually joined
-- (the invite set is channel_members); for MEETING and DIRECT it is both the
-- invite set and the attendance record.
CREATE TABLE IF NOT EXISTS call_participants (
    call_id     uuid NOT NULL,
    user_id     uuid NOT NULL,
    -- The PARTICIPANT's org, which for a cross-org meeting guest is NOT the
    -- call's org. Carried explicitly so the grant check never has to join out
    -- to a table in another service's database.
    org_id      uuid NOT NULL,
    role        text NOT NULL DEFAULT 'PARTICIPANT'
                CHECK (role IN ('HOST', 'PARTICIPANT')),
    -- How this participant got in, for audit: who added them, or NULL when they
    -- redeemed an invite link themselves.
    invited_by  uuid,
    -- Set when they redeemed a link rather than being added directly.
    via_invite  uuid,
    joined_at   timestamptz,
    left_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (call_id, user_id)
);

-- ── call_invites ─────────────────────────────────────────────────────────────
-- MEETING links only. CHANNEL calls have no invite path at all — there is no
-- row here for them and the API refuses to mint one.
CREATE TABLE IF NOT EXISTS call_invites (
    id          uuid PRIMARY KEY,
    call_id     uuid NOT NULL,
    org_id      uuid NOT NULL,
    -- SHA-256 of the token. The token itself is shown to the creator once and
    -- never stored, so a database read cannot join a meeting.
    token_hash  bytea NOT NULL UNIQUE,
    created_by  uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    -- NULL = unlimited redemptions until expiry.
    max_uses    int,
    uses        int NOT NULL DEFAULT 0,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- "Upcoming calls in this channel", the channel-call list query.
CREATE INDEX IF NOT EXISTS idx_calls_channel_upcoming
    ON calls (channel_id, scheduled_at DESC)
    WHERE channel_id IS NOT NULL AND status IN ('SCHEDULED', 'LIVE');

-- "My org's meetings", newest first.
CREATE INDEX IF NOT EXISTS idx_calls_org_scheduled
    ON calls (org_id, scheduled_at DESC);

-- "Calls I am in" — drives both the participant list and the RLS grant, so it
-- carries the user first.
CREATE INDEX IF NOT EXISTS idx_call_participants_user
    ON call_participants (user_id, call_id);

-- Live roster for a call, which is what ring fan-out reads.
CREATE INDEX IF NOT EXISTS idx_call_participants_call
    ON call_participants (call_id)
    WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_call_invites_call
    ON call_invites (call_id)
    WHERE revoked_at IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
DO $calls_rls$
BEGIN
    -- calls: own org, OR a call you are a participant of (the cross-org grant).
    IF EXISTS (SELECT 1 FROM pg_tables
               WHERE schemaname = current_schema() AND tablename = 'calls') THEN
        EXECUTE 'ALTER TABLE calls ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE calls FORCE ROW LEVEL SECURITY';

        IF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE policyname = 'call_access' AND tablename = 'calls'
                         AND schemaname = current_schema()) THEN
            EXECUTE $pol$
                CREATE POLICY call_access ON calls
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR EXISTS (
                            SELECT 1 FROM call_participants cp
                            WHERE cp.call_id = calls.id
                              AND cp.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                        )
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    -- WITH CHECK is org-only ON PURPOSE: a cross-org guest may
                    -- READ the call they were invited to, but only the hosting
                    -- org may create or modify one.
                    WITH CHECK (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
            $pol$;
        END IF;
    END IF;

    -- call_participants: own org, OR your own row. NO subquery here — this is
    -- what keeps calls' policy from recursing.
    IF EXISTS (SELECT 1 FROM pg_tables
               WHERE schemaname = current_schema() AND tablename = 'call_participants') THEN
        EXECUTE 'ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE call_participants FORCE ROW LEVEL SECURITY';

        IF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE policyname = 'call_participant_access'
                         AND tablename = 'call_participants'
                         AND schemaname = current_schema()) THEN
            EXECUTE $pol$
                CREATE POLICY call_participant_access ON call_participants
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    WITH CHECK (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
            $pol$;
        END IF;
    END IF;

    -- call_invites: hosting org only. Redemption runs under bypass in trusted
    -- server code, because the redeemer by definition cannot see the row yet.
    IF EXISTS (SELECT 1 FROM pg_tables
               WHERE schemaname = current_schema() AND tablename = 'call_invites') THEN
        EXECUTE 'ALTER TABLE call_invites ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE call_invites FORCE ROW LEVEL SECURITY';

        IF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE policyname = 'org_isolation' AND tablename = 'call_invites'
                         AND schemaname = current_schema()) THEN
            EXECUTE $pol$
                CREATE POLICY org_isolation ON call_invites
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    WITH CHECK (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
            $pol$;
        END IF;
    END IF;
END
$calls_rls$;

-- 0016_call_sharing_and_lobby.sql — screen sharing, and a waiting room in front
-- of scheduled calls.
--
-- Two features, one migration, because both hang off the same two tables and
-- both need the cross-org read that 0015 established.
--
-- ── 1. Screen sharing ────────────────────────────────────────────────────────
-- Media itself never touches this database — a screen track is published to the
-- SFU exactly like a camera track, and the room token already permits it. What
-- the SFU does NOT give us is a durable, agreed answer to "who is sharing what,
-- and who may stop it". That is what call_screenshares is for:
--
--   * a participant who joins late learns a share is already in progress from
--     the call row rather than from whatever tracks happen to arrive first;
--   * "tab / window / entire screen" is recorded, so the room can label the
--     share without every client having to guess from the track dimensions; and
--   * the STOP authority gets a home. The product rule is that the stop-sharing
--     control belongs to the person sharing and to nobody else, so the write
--     policy below is scoped to your OWN row: there is no request another
--     participant can make that would end your share.
--
-- ── 2. The waiting room ──────────────────────────────────────────────────────
-- Until now the first participant to ask for a room token flipped a SCHEDULED
-- call to LIVE (store.MarkJoined), so a meeting effectively started whenever its
-- earliest arrival opened it — the organiser could walk into a call that had
-- been running for ten minutes without them. `waiting_since` and `started_by`
-- split those two events apart: arriving is not starting.
--
-- Nobody is admitted or refused individually. A joiner who arrives early is
-- parked, the call starting clears the whole lobby at once, and there is no
-- per-person approval anywhere in this schema — which is the point. The lobby is
-- a WAITING ROOM, not an approval queue.

-- ── calls.started_by ─────────────────────────────────────────────────────────
-- Who actually started the call, which is not always who scheduled it: an org
-- admin or a channel owner may start a meeting the organiser is late for.
-- Separate from created_by so "who called this meeting" survives that.
ALTER TABLE calls
    ADD COLUMN IF NOT EXISTS started_by uuid;

-- ── call_participants.waiting_since ──────────────────────────────────────────
-- Set when someone asks to enter a call that has not started, cleared when the
-- call starts (and they are admitted) or when they give up and leave.
--
-- NULL therefore means "not in the lobby" — which covers both the people already
-- in the room and the invitees who have not shown up yet. It is deliberately a
-- timestamp rather than a boolean: a host looking at a lobby wants to know who
-- has been waiting longest, and "how early do people actually arrive" is the
-- kind of question that is impossible to answer retroactively from a flag.
ALTER TABLE call_participants
    ADD COLUMN IF NOT EXISTS waiting_since timestamptz;

-- ── call_screenshares ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_screenshares (
    id          uuid PRIMARY KEY,
    call_id     uuid NOT NULL,
    -- The SHARER. One row per share session, not per participant, so stopping
    -- and re-sharing leaves two rows and an honest history.
    user_id     uuid NOT NULL,
    -- The HOSTING org, matching call_invites and NOT call_participants.
    --
    -- This is the difference that makes ending a call able to close a guest's
    -- share. A cross-org guest's participant row carries their OWN org (that is
    -- what makes them visible to their own org's RLS); if the share row did the
    -- same, the hosting org's write policy could not touch it, and a meeting
    -- could end with an external screen share still recorded as live.
    org_id      uuid NOT NULL,
    -- What is on screen. Mirrors the three things a browser will actually hand
    -- over from getDisplayMedia's displaySurface, normalised server-side:
    -- 'monitor' → SCREEN, 'browser' → TAB, 'window' → WINDOW.
    source      text NOT NULL CHECK (source IN ('SCREEN', 'WINDOW', 'TAB')),
    started_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL while the share is live. There is no stopped_by column on purpose:
    -- only the sharer can stop a share, so it would record the same value as
    -- user_id on every row that has one.
    stopped_at  timestamptz
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- One live share per person per call. Re-sharing without stopping is a client
-- bug, and this makes it a constraint violation rather than two rows that
-- disagree about what is on screen. Participants may share CONCURRENTLY with
-- each other — this bounds each person, not the room.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_screenshares_live
    ON call_screenshares (call_id, user_id)
    WHERE stopped_at IS NULL;

-- "What is being shared in this call right now", read on every call fetch.
CREATE INDEX IF NOT EXISTS idx_call_screenshares_call
    ON call_screenshares (call_id)
    WHERE stopped_at IS NULL;

-- The lobby roster for one call.
CREATE INDEX IF NOT EXISTS idx_call_participants_waiting
    ON call_participants (call_id)
    WHERE waiting_since IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
DO $screenshare_rls$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables
               WHERE schemaname = current_schema() AND tablename = 'call_screenshares') THEN
        EXECUTE 'ALTER TABLE call_screenshares ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE call_screenshares FORCE ROW LEVEL SECURITY';

        IF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE policyname = 'call_screenshare_access'
                         AND tablename = 'call_screenshares'
                         AND schemaname = current_schema()) THEN
            EXECUTE $pol$
                CREATE POLICY call_screenshare_access ON call_screenshares
                    -- READ mirrors calls' policy exactly: the hosting org, plus
                    -- anyone who is a participant. The second disjunct is what
                    -- lets a cross-org meeting guest see that the host is
                    -- sharing — without it they would be in the room watching a
                    -- screen the API told them nobody was sharing.
                    --
                    -- Not recursive: this subqueries call_participants, whose
                    -- own policy contains no subquery. RLS still applies inside
                    -- it, so the EXISTS reduces to "am I in this call".
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR EXISTS (
                            SELECT 1 FROM call_participants cp
                            WHERE cp.call_id = call_screenshares.call_id
                              AND cp.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                        )
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    -- WRITE is narrower than read, and that asymmetry IS the
                    -- feature: "only the sharer can stop the share" is enforced
                    -- here, not only in the handler that happens to sit in front
                    -- of it.
                    --
                    -- The second disjunct exists solely so ending a call can
                    -- close the shares still open in it, and it is qualified
                    -- with `stopped_at IS NOT NULL` so that is ALL it can do:
                    -- the hosting org may close a share it can see, but cannot
                    -- start one in someone else's name, and cannot reopen one
                    -- that has already stopped. A forged share is therefore not
                    -- expressible even by a member of the org hosting the call.
                    WITH CHECK (
                        user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                        OR (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                            AND stopped_at IS NOT NULL)
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
            $pol$;
        END IF;
    END IF;
END
$screenshare_rls$;

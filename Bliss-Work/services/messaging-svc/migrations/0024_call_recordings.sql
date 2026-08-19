-- 0024_call_recordings.sql — the recording of a call, and where its bytes live.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── What actually records ────────────────────────────────────────────────────
-- Nothing in this service touches media. A recording is made by LiveKit Egress:
-- messaging-svc asks the SFU to start a room-composite egress when a call is
-- opened, egress writes ONE file, and the SFU reports the result back over the
-- webhook. This table is the durable half of that conversation — the part that
-- survives an egress restart, and the only part the product reads.
--
-- ── Why a row exists before there is a file ──────────────────────────────────
-- The row is written when the egress is REQUESTED, not when it finishes, so a
-- recording that dies mid-call is still visible as one that failed. A host who
-- was told "this call is being recorded" and then finds nothing has been
-- misled by silence; FAILED with an error on it is the honest answer.
--
-- ── Where the bytes live ─────────────────────────────────────────────────────
-- `storage_key` is a key in the SAME blob store attachments use, deliberately
-- under `blobs/{org_id}/…` so that org erasure (blob.Store.RemoveOrg, a single
-- prefix removal) takes the recordings with it. Nothing else reaches these
-- bytes: they are not application-layer encrypted, for the same reasons the
-- attachment blobs are not (see 0010).

CREATE TABLE IF NOT EXISTS call_recordings (
    id           uuid PRIMARY KEY,
    call_id      uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    -- The HOSTING org, matching call_invites and call_screenshares rather than
    -- call_participants: the recording belongs to the meeting, not to whoever
    -- happens to be watching it.
    org_id       uuid NOT NULL,
    -- LiveKit's own handle for the egress. The webhook carries this and nothing
    -- else that identifies the call, so it is the join key, and it is UNIQUE so
    -- a redelivered webhook updates the same row instead of forking history.
    egress_id    text NOT NULL,
    status       text NOT NULL DEFAULT 'RECORDING'
                 CHECK (status IN ('RECORDING', 'READY', 'FAILED')),
    -- Blob key, set once the file has landed. NULL while recording, and stays
    -- NULL on failure — which is what makes "READY implies playable" true.
    storage_key  text,
    mime         text NOT NULL DEFAULT 'video/mp4',
    size_bytes   bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    duration_ms  bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    -- Kept for the operator, never returned to a participant: an egress failure
    -- names paths and buckets.
    error        text,
    started_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_recordings_egress
    ON call_recordings (egress_id);

-- "The recording of this call", which is every read this table has.
CREATE INDEX IF NOT EXISTS idx_call_recordings_call
    ON call_recordings (call_id, started_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
DO $call_recording_rls$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables
               WHERE schemaname = current_schema() AND tablename = 'call_recordings') THEN
        EXECUTE 'ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE call_recordings FORCE ROW LEVEL SECURITY';

        IF NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE policyname = 'call_recording_access'
                         AND tablename = 'call_recordings'
                         AND schemaname = current_schema()) THEN
            EXECUTE $pol$
                CREATE POLICY call_recording_access ON call_recordings
                    -- READ mirrors call_screenshares: the hosting org, plus
                    -- anyone on the roster. The second disjunct is the whole
                    -- point for a cross-org meeting — a guest who sat through
                    -- the call may watch it back, and is not made to ask the
                    -- host for a copy.
                    --
                    -- Not recursive: call_participants' own policy contains no
                    -- subquery, and RLS still applies inside this EXISTS, so it
                    -- reduces to "was I in this call".
                    USING (
                        org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                        OR EXISTS (
                            SELECT 1 FROM call_participants cp
                            WHERE cp.call_id = call_recordings.call_id
                              AND cp.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                        )
                        OR current_setting('app.bypass_rls', true) = 'on'
                    )
                    -- WRITE is server-only. Every write here comes from the
                    -- egress conversation — starting one, and the webhook that
                    -- reports how it ended — and the webhook has no user at all
                    -- to attribute the row to, so it runs under bypass. There
                    -- is deliberately no disjunct that lets a REQUEST write one.
                    WITH CHECK (current_setting('app.bypass_rls', true) = 'on')
            $pol$;
        END IF;
    END IF;
END
$call_recording_rls$;

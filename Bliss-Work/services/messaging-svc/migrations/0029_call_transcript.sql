-- 0029_call_transcript.sql — what was SAID and WRITTEN in a meeting, kept.
--
-- This migration is IDEMPOTENT. Store.Migrate re-Execs every file on EVERY boot,
-- so every statement guards re-execution.
--
-- ── What was missing ─────────────────────────────────────────────────────────
-- A call already left a thorough record of itself: who was invited, who
-- actually turned up and when they left (call_participants), when it started
-- and ended (calls), what was on screen (call_screenshares) and where the
-- recording landed (call_recordings). The two things people actually produce
-- IN a meeting were the exception.
--
-- Meeting chat and the shared notes lived only on the SFU's data channel and in
-- each participant's own localStorage. That had real consequences, none of them
-- intended: the notes a team took together disappeared when they signed out,
-- somebody who joined late never saw what was agreed before they arrived, and
-- nobody who missed the meeting could read any of it. A "past meeting" was a
-- row with a duration on it and nothing to read.
--
-- These two tables are the server copy. The data channel still carries both
-- live — that is what makes them appear instantly for everyone in the room, and
-- it is untouched — and this is what makes them survive the room.
--
-- ── Room-wide only, on purpose ───────────────────────────────────────────────
-- Meeting chat can be addressed to ONE person, and such a message is delivered
-- by the SFU to that person alone: a third participant never receives the
-- bytes. Persisting those here would take a message whose audience was one
-- person and make it readable by everyone the call's read policy admits, which
-- is a privacy regression the feature request did not ask for and nobody sending
-- one would expect. So the API refuses to store a directed message, and this
-- table has no recipient column to put one in — the schema cannot express it.
--
-- Notes carry no such distinction: a note is written to the room by definition.
--
-- ── At-rest encryption ───────────────────────────────────────────────────────
-- Both bodies are message content and are encrypted exactly like every other
-- message body in this database (see 0006): AES-256-GCM under the per-org DEK,
-- self-describing ciphertext in a `*_enc bytea`, encrypt-on-write and
-- decrypt-on-read in the store layer. Unlike the tables 0006 retrofitted there
-- is no plaintext column at all here — nothing predates this migration, so
-- there is no backfill to leave room for and no way to write a plaintext body
-- by accident.
--
-- ── Whose org ────────────────────────────────────────────────────────────────
-- org_id is the HOSTING org, matching call_recordings and call_screenshares
-- rather than call_participants. The transcript belongs to the meeting, not to
-- whichever org the person typing happens to be in — and a cross-org guest's
-- messages have to remain readable by the host, which an org_id of the guest's
-- own org would prevent.

-- ── call_chat_messages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_chat_messages (
    id         uuid PRIMARY KEY,
    call_id    uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    org_id     uuid NOT NULL,
    sender_id  uuid NOT NULL,
    -- The id the SENDER's client already minted for the data-channel copy of
    -- this message, used purely as an idempotency key — exactly what
    -- channel_messages.client_msg_id is for, and keyed the same way below.
    --
    -- It is deliberately NOT the primary key. The client's id is a string it
    -- composes itself ("alice-1738…-x7q2"), so making it the key would hand a
    -- participant the primary key of a shared table and force a format change
    -- on a protocol that is working. Server-minted uuid for identity, client
    -- string for "have I already stored this one".
    client_entry_id text NOT NULL,
    body_enc   bytea NOT NULL,
    -- When the SENDER's client says it was sent, so a transcript reads in the
    -- order the room experienced rather than in the order requests happened to
    -- arrive. Clamped to a sane window server-side; created_at is the server's
    -- own unforgeable record beside it.
    sent_at    timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ── call_notes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_notes (
    id         uuid PRIMARY KEY,
    call_id    uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
    org_id     uuid NOT NULL,
    -- Who wrote the point. The display name is NOT stored: it is looked up from
    -- the directory at read time like every other author in this product, so a
    -- note does not keep calling somebody by a name they have since changed.
    author_id  uuid NOT NULL,
    -- Same idempotency key as call_chat_messages above, same reasons.
    client_entry_id text NOT NULL,
    body_enc   bytea NOT NULL,
    written_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- "The transcript of this meeting, in order" — the only read either table has,
-- and a keyset page over it. The id tie-breaks two entries inside the same
-- millisecond so the cursor cannot loop or skip.
CREATE INDEX IF NOT EXISTS idx_call_chat_call
    ON call_chat_messages (call_id, sent_at, id);

CREATE INDEX IF NOT EXISTS idx_call_notes_call
    ON call_notes (call_id, written_at, id);

-- Idempotency. Keyed on the SENDER as well as the call, mirroring
-- channel_messages' (channel_id, sender_id, client_msg_id): two participants
-- whose clients happen to compose the same entry id are two different entries,
-- and one participant sending the same one twice is one.
--
-- UNIQUE rather than a plain index on purpose — it is what makes the
-- ON CONFLICT upsert in the store a constraint the database enforces rather
-- than a race the store hopes to win.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_chat_client_entry
    ON call_chat_messages (call_id, sender_id, client_entry_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_notes_client_entry
    ON call_notes (call_id, author_id, client_entry_id);

-- ── The Past list's keyset ───────────────────────────────────────────────────
-- The meetings history is "calls I was in, newest first", paged. Without this
-- the join drives a scan of every participant row the caller has ever had and
-- sorts the lot on every page. Ordered to match the query exactly — the sort
-- expression is COALESCE(scheduled_at, started_at, created_at), which is not
-- indexable through the join, so this covers the participant side and lets the
-- planner walk the call rows it points at.
CREATE INDEX IF NOT EXISTS idx_call_participants_user_call
    ON call_participants (user_id, call_id);

-- The call side of the same page: finished calls, newest first. The expression
-- is the sort key ListMyCallHistory orders by, and it is the same "when did
-- this meeting happen" the client computes (lib/meetingTime.whenOf) — the two
-- disagreeing would make the cursor skip rows the list had already shown.
--
-- Partial on the finished statuses because that is the only bucket that pages:
-- Upcoming and Live are bounded by what is actually on the calendar, and index
-- entries for them would grow the index without ever being read by this query.
CREATE INDEX IF NOT EXISTS idx_calls_history_when
    ON calls ((COALESCE(scheduled_at, started_at, ended_at, created_at)) DESC, id DESC)
    WHERE status IN ('ENDED', 'CANCELLED');

-- ── RLS ──────────────────────────────────────────────────────────────────────
DO $call_transcript_rls$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['call_chat_messages', 'call_notes'] LOOP
        IF EXISTS (SELECT 1 FROM pg_tables
                   WHERE schemaname = current_schema() AND tablename = t) THEN
            EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

            IF NOT EXISTS (SELECT 1 FROM pg_policies
                           WHERE policyname = 'call_transcript_access'
                             AND tablename = t
                             AND schemaname = current_schema()) THEN
                -- READ mirrors call_recordings exactly: the hosting org, plus
                -- anyone on the roster. The second disjunct is the whole point
                -- for a cross-org meeting — a guest who sat through the call
                -- may read back what was said in it.
                --
                -- Not recursive: call_participants' own policy contains no
                -- subquery, and RLS still applies inside this EXISTS, so it
                -- reduces to "was I in this call".
                --
                -- WRITE is narrower than read, and the asymmetry IS the
                -- feature. You may only write in your OWN name, and only into
                -- a call you are on the roster of. Being in the hosting org is
                -- deliberately NOT sufficient: an org admin who was not in the
                -- meeting cannot insert a line into its transcript, so the
                -- record cannot be edited after the fact by anyone.
                EXECUTE format($pol$
                    CREATE POLICY call_transcript_access ON %1$I
                        USING (
                            org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                            OR EXISTS (
                                SELECT 1 FROM call_participants cp
                                WHERE cp.call_id = %1$I.call_id
                                  AND cp.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                            )
                            OR current_setting('app.bypass_rls', true) = 'on'
                        )
                        WITH CHECK (
                            (%2$I = NULLIF(current_setting('app.user_id', true), '')::uuid
                             AND EXISTS (
                                 SELECT 1 FROM call_participants cp
                                 WHERE cp.call_id = %1$I.call_id
                                   AND cp.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
                             ))
                            OR current_setting('app.bypass_rls', true) = 'on'
                        )
                $pol$, t, CASE t WHEN 'call_chat_messages' THEN 'sender_id' ELSE 'author_id' END);
            END IF;
        END IF;
    END LOOP;
END
$call_transcript_rls$;

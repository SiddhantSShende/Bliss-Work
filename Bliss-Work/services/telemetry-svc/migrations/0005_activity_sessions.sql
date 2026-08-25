-- 0005_activity_sessions — coherent, correlated activity sessions.
--
-- Everything before this migration records what one sensor saw: `activity_events`
-- holds a `Google Chrome` app.focus row from the desktop agent and a
-- `youtube.com` site.visit row from the browser extension as two independent
-- rows, correlated only at READ time by the timeline's collapseSwitches, which
-- picks the more specific of the two and DISCARDS the other's fields.
--
-- This table is a different thing: a MERGED record — "Chrome, showing YouTube,
-- 'Learn Go in 30 Minutes', 15:00-15:14" as one row with both sensors'
-- contributions in it, not two rows where one wins. It is derived from
-- activity_events (never a second source of truth) and is safe to fully
-- recompute from it at any time.
--
-- ── Why a session's identity is the DESKTOP span, not a synthetic id ─────────
-- A desktop app.focus row already IS a coherent unit — one foreground span,
-- start time and duration known the moment it arrives (see activity-agent.ts's
-- closeCurrent). Anchoring the session on it means "when did this application
-- have focus" answers itself the same way whether or not a browser happened to
-- be running underneath, which is what keeps requirement 9 (missing desktop
-- data must not lose browser activity — see the standalone-session path in
-- sessionizer.py) and requirement 10 (missing browser data must not lose
-- desktop activity) both true without two different code paths.
CREATE TABLE IF NOT EXISTS activity_sessions (
    id             uuid        PRIMARY KEY,   -- uuid7
    org_id         uuid        NOT NULL,
    user_id        uuid        NOT NULL,
    -- The activity_events row this session is anchored on — a desktop
    -- app.focus row when one exists (the common case), or a site.visit row
    -- standing in for itself when no desktop signal ever arrived for that
    -- window (extension-only coverage). Nullable FK-by-convention, not a real
    -- foreign key: activity_events is partitioned by occurred_at, and a
    -- same-table FK across partitions is exactly the coupling 0001_init.sql's
    -- partitioning note already explains the schema avoids elsewhere.
    anchor_event_id     uuid        NOT NULL,
    correlated_event_id uuid,                 -- the OTHER sensor's row, if one was found
    started_at     timestamptz NOT NULL,
    ended_at       timestamptz NOT NULL,
    duration_ms    integer     NOT NULL,
    -- What kind of session this is — drives how the UI's three-line render
    -- picks fields: 'app' when only the desktop sensor contributed, 'site'
    -- when only the browser did, 'app+site' when both correlated into one.
    kind           text        NOT NULL,
    app_name       text,                      -- desktop: resolved app/browser name
    domain         text,                      -- browser: registrable domain
    title          text,                      -- page/window title (see note below)
    detail_enc     bytea,                     -- url, siteKind, siteRef, from — encrypted, same convention as activity_events.detail_enc
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- `title` is stored in the CLEAR here, unlike activity_events.detail_enc where
-- every free-text field is encrypted. This is a deliberate, narrow exception:
-- idx_sessions_correlate below has to find "an open browser span whose title
-- we might still update" and "sessions in this app_name for rollup" by
-- ordinary indexed lookups, which an encrypted column cannot support. The
-- SAME title already exists in activity_events.detail_enc (encrypted) for the
-- row this session was built from — this table is a derived, recomputable
-- projection of that data for the UI's fast path, not a new place sensitive
-- text originates. A future pass that needs this encrypted can rebuild the
-- table from activity_events, which remains the source of truth.
--
-- (This mirrors this migration's own opening paragraph: recomputable from
-- activity_events, never authoritative on its own.)

CREATE INDEX IF NOT EXISTS idx_sessions_user_time
    ON activity_sessions (org_id, user_id, started_at DESC);   -- the timeline read
CREATE INDEX IF NOT EXISTS idx_sessions_anchor
    ON activity_sessions (org_id, anchor_event_id);             -- upsert-by-anchor
CREATE INDEX IF NOT EXISTS idx_sessions_correlate
    ON activity_sessions (org_id, user_id, started_at, ended_at)
    WHERE correlated_event_id IS NULL;                          -- "find an uncorrelated span to attach to"

SELECT apply_org_isolation('activity_sessions');

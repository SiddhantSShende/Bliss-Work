-- Keep lifecycle projections ordered by the auth event's canonical timestamp.
-- The epoch default lets the next event supersede existing projection rows.
ALTER TABLE user_projection
    ADD COLUMN IF NOT EXISTS source_occurred_at timestamptz NOT NULL
    DEFAULT '-infinity'::timestamptz;

-- 0018_audit_log_uuid_id.sql — audit_log.id: bigserial -> app-generated UUIDv7.
--
-- Every other primary key in this schema (and across the platform — see
-- task-svc, messaging-svc, telemetry-svc, integrations-svc) is an
-- app-generated UUIDv7: time-ordered, opaque, and safe to shard/partition
-- later (service.py's `new_uuid()` — used for orgs, users, invites,
-- refresh_tokens, mfa_*, etc.). audit_log.id was the one holdout: a
-- bigserial, dating to 0001_init before that convention was settled. Two
-- concrete costs of leaving it that way:
--   * A single global sequence is exactly what blocks clean future table
--     partitioning (by org_id or by time) — every partition would still need
--     to coordinate through one sequence.
--   * The id leaks the total row count of a security log to anyone who can
--     compare two entries' ids, even across orgs.
--
-- id is safe to swap: it is used ONLY for ordering (keyset pagination in
-- routes/members.py's GET /audit, and the "find the last row for this org"
-- lookup in service.write_audit) and is NOT part of the tamper-evident hash
-- chain itself — _audit_entry_hash hashes exactly six fixed fields (org,
-- actor, action, target, meta, at), never id. UUIDv7 is time-ordered, so
-- `ORDER BY id` keeps meaning exactly what it always meant.
--
-- 0001_init.sql already shipped to production, and app/db.py's migration
-- ledger keys on filename+checksum, so it cannot be edited in place (see its
-- run_migrations() docstring) — hence a new file rather than touching the
-- original CREATE TABLE.
--
-- Additive-then-swap, not a blind `ALTER ... TYPE`, because this table may
-- already hold production rows: add the new column, backfill it, THEN swap
-- the primary key over. The backfill preserves the table's existing write
-- order EXACTLY (not just approximately by timestamp): each row's UUIDv7 is
-- built from a per-row monotonic counter (`row_number() OVER (ORDER BY
-- id)`) placed in the trailing random bits, with the leading 48-bit
-- timestamp field taken from a running maximum of `at` — never decreasing in
-- id order, even if two app replicas' clocks were ever slightly out of step
-- when they wrote adjacent rows for the same org. `ORDER BY id_new` is
-- therefore guaranteed identical, row for row, to the current `ORDER BY id`
-- — required, because verify_audit_chain() and write_audit()'s "fetch the
-- previous entry_hash" lookup both depend on walking rows in exactly their
-- original write order.
--
-- Idempotent: the whole backfill+swap is guarded so a second run (e.g. a
-- pod re-applying this file, or a manual re-run) against an already-migrated
-- database is a no-op.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'audit_log' AND column_name = 'id' AND data_type = 'bigint'
    ) THEN
        ALTER TABLE audit_log ADD COLUMN id_new uuid;

        WITH ordered AS (
            SELECT
                id,
                max(at) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS effective_at,
                row_number() OVER (ORDER BY id) AS rn
            FROM audit_log
        )
        UPDATE audit_log a
        SET id_new = encode(
            set_bit(
            set_bit(
            set_bit(
            set_bit(
                overlay(
                    -- bytes 0-5: 48-bit ms timestamp (the row's own write time,
                    -- clamped to never run backwards relative to id order).
                    overlay(
                        '\x00000000000000000000000000000000'::bytea
                        placing substring(int8send(floor(extract(epoch FROM o.effective_at) * 1000)::bigint) FROM 3)
                        FROM 1 FOR 6
                    )
                    -- bytes 9-15: the per-row counter, not randomness — this is
                    -- what makes id_new order match the old id order exactly,
                    -- including rows that share a millisecond (a real case: the
                    -- per-org advisory lock in write_audit allows back-to-back
                    -- writes faster than 1ms apart).
                    placing substring(int8send(o.rn) FROM 2)
                    FROM 10 FOR 7
                ),
            71, 1),  -- variant bits "10" (byte 8, top bit)
            54, 1),  -- version nibble bit (byte 6, high nibble) -\
            53, 1),  --                                            > 0111 = v7
            52, 1),  --                                          -/
            'hex')::uuid
        FROM ordered o
        WHERE a.id = o.id;

        ALTER TABLE audit_log ALTER COLUMN id_new SET NOT NULL;

        -- RENAME (not drop+recreate) so idx_audit_log_org_chain's column
        -- reference carries forward automatically at each step below —
        -- indexes track a column by attnum, so renaming a column updates
        -- every index/constraint that mentions it with no extra DDL.
        ALTER TABLE audit_log RENAME COLUMN id TO id_old;
        ALTER TABLE audit_log RENAME COLUMN id_new TO id;

        ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_pkey;
        ALTER TABLE audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

        -- Dropping id_old also drops its owned sequence (bigserial's implicit
        -- `OWNED BY`, so no separate DROP SEQUENCE is needed) and
        -- idx_audit_log_org_chain, which — post-rename — still points at
        -- id_old (again: bound by attnum, not name). Recreated below on the
        -- new id.
        ALTER TABLE audit_log DROP COLUMN id_old;
    END IF;
END $$;

-- 0004_audit_chain.sql's index, recreated on the new uuid id (see comment
-- above: dropping id_old drops the old copy of this index along with it).
CREATE INDEX IF NOT EXISTS idx_audit_log_org_chain ON audit_log (org_id, id);

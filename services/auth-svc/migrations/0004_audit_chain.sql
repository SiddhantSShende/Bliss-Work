-- 0004: tamper-evident audit log — hash-chain each entry to the previous one
-- (per org). entry_hash = SHA256(prev_hash || canonical(entry fields)); the first
-- entry chains from a fixed genesis (32 zero bytes). Modifying, deleting, or
-- reordering any row breaks the chain from that point on, which
-- service.verify_audit_chain() detects. Additive + idempotent.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash  bytea;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash bytea;

-- Walk an org's chain in insertion order efficiently.
CREATE INDEX IF NOT EXISTS idx_audit_log_org_chain ON audit_log (org_id, id);

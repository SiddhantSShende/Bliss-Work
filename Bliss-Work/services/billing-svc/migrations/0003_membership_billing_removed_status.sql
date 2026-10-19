-- Phase 4: a released/removed membership commitment needs a third status.
-- 'removed' means "no longer part of the org's projected monthly commitment"
-- — set when a member is actually removed, AND as compensation when a
-- commitment check succeeded but the auth-svc change it was gating then
-- failed to apply (see auth-svc/app/billing_client.py).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'org_membership_billing'::regclass
        AND conname = 'org_membership_billing_status_check'
    ) THEN
        ALTER TABLE org_membership_billing DROP CONSTRAINT org_membership_billing_status_check;
    END IF;
    ALTER TABLE org_membership_billing ADD CONSTRAINT org_membership_billing_status_check
        CHECK (status IN ('active', 'suspended', 'removed'));
END $$;

-- Speeds up the per-org projected-commitment aggregate the commitment check
-- runs on every provisioning request.
CREATE INDEX IF NOT EXISTS idx_org_membership_billing_org_active
    ON org_membership_billing (org_id)
    WHERE status = 'active';

-- Channel roles: owner / admin / member.
--
-- Until now a channel had no permission model at all — `requireChannelMember`
-- was the only check, so any member could add any other member and nobody could
-- remove anyone. `channels.created_by` has been written since 0002 and never
-- once read back; this migration is the first code to select it.
--
-- Effective permission is `role IN ('owner','admin') OR org_admin ∈ JWT roles`.
-- Org admins deliberately do NOT need to be members: moderating a channel you
-- are not in is the entire point of the capability.

ALTER TABLE channel_members
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';

-- CRITICAL: migrations run as the least-priv service role (messaging_user) with
-- NO org context, and `channel_members` is FORCE-RLS — FORCE subjects the table
-- OWNER too, which is exactly who runs migrations here. Without the bypass the
-- backfill sees ZERO rows (fail-closed) and silently does nothing: every channel
-- in the product ends up with no owner, and the failure surfaces much later as
-- "why can nobody moderate anything".
--
-- Wrapped in a DO block, matching auth-svc/0007_identities.sql, because
-- set_config(..., is_local => true) is TRANSACTION-local: as bare top-level
-- statements each one is its own implicit transaction, so the bypass would have
-- expired before the UPDATE ran. A DO block is a single statement, so the whole
-- backfill shares one transaction and one GUC.
DO $bf$
BEGIN
    PERFORM set_config('app.bypass_rls', 'on', true);

    UPDATE channel_members cm
       SET role = 'owner'
      FROM channels c
     WHERE c.id = cm.channel_id
       AND c.created_by = cm.user_id
       AND cm.role = 'member';

    PERFORM set_config('app.bypass_rls', 'off', true);
END
$bf$;

-- Permission checks read (channel_id, user_id) → role on every send and every
-- moderation action; the PK already covers that lookup, so no new index.

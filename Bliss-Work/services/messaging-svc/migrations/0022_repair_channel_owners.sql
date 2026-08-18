-- 0022_repair_channel_owners.sql — give ownerless channels their creator back.
--
-- 0012_channel_roles introduced owner/admin/member and backfilled `owner` from
-- `channels.created_by` for every channel that existed at the time. What it did
-- NOT do is update the insert in CreateChannel, which kept writing the column
-- default — so every channel created between that migration and this one has no
-- owner at all.
--
-- The visible symptom is the one that was reported: a member creates a channel
-- and has no "Add people" — the client hides an action the server would refuse.
-- The rest of moderation was gone with it. Changing roles, kicking and blocking
-- all require owner/admin, so an org admin was the only person in the world who
-- could moderate those channels, and only by never being a member of them.
--
-- The code fix (store.CreateChannel now inserts the creator as `owner`) covers
-- new channels. This covers the ones already out there.
--
-- Idempotent, like every file here: a re-run finds nothing left to promote.

-- Same bypass-and-DO-block dance as 0012, and for the same reason: migrations
-- run as the least-privileged service role with no org context, and
-- channel_members is FORCE-RLS — which applies to the table owner too. Without
-- the bypass this UPDATE matches ZERO rows and commits as a silent no-op.
-- set_config(..., is_local => true) is transaction-local, so it has to share a
-- statement with the UPDATE; a DO block is one statement.
DO $repair$
DECLARE
    fixed int;
BEGIN
    PERFORM set_config('app.bypass_rls', 'on', true);

    -- ONLY channels that have no owner at all.
    --
    -- 0012's predicate was `created_by = user_id AND role = 'member'`, which is
    -- too broad to re-run now: ownership can be transferred (the old owner is
    -- demoted to admin, not member) and a creator can be kicked and re-join as
    -- an ordinary member. Either way the channel already has an owner, and
    -- promoting the creator over them would undo a decision somebody made.
    WITH promoted AS (
        UPDATE channel_members cm
           SET role = 'owner'
          FROM channels c
         WHERE c.id = cm.channel_id
           AND c.created_by = cm.user_id
           AND cm.role = 'member'
           AND NOT EXISTS (
               SELECT 1 FROM channel_members o
                WHERE o.channel_id = c.id AND o.role = 'owner'
           )
        RETURNING 1
    )
    SELECT count(*) INTO fixed FROM promoted;

    PERFORM set_config('app.bypass_rls', 'off', true);

    -- Said out loud: this is a data repair, and the number is how many channels
    -- were unmoderatable. A deploy log that shows a large number here is worth
    -- knowing about; a re-run showing 0 is the expected steady state.
    RAISE NOTICE '0022: gave % channel(s) their creator back as owner', fixed;
END
$repair$;

-- Channels that STILL have no owner after the repair are ones whose creator is
-- no longer a member (they left, or were removed). There is no honest automatic
-- answer for those — promoting an arbitrary member would hand someone authority
-- nobody granted them — so they are reported and left for an org admin, who can
-- moderate any channel without being in it and can appoint an owner.
DO $orphans$
DECLARE
    orphans int;
BEGIN
    PERFORM set_config('app.bypass_rls', 'on', true);
    SELECT count(*) INTO orphans
      FROM channels c
     WHERE NOT EXISTS (
           SELECT 1 FROM channel_members o
            WHERE o.channel_id = c.id AND o.role = 'owner'
       );
    PERFORM set_config('app.bypass_rls', 'off', true);
    IF orphans > 0 THEN
        RAISE NOTICE '0022: % channel(s) have no member who created them — an org admin must appoint an owner', orphans;
    END IF;
END
$orphans$;

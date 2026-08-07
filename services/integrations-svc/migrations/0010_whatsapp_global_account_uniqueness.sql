-- 0010_whatsapp_global_account_uniqueness.sql — one phone number, one connection.
-- Idempotent; replayed on every boot by db.py::run_migrations.
--
-- SECURITY, not tidiness. Every WhatsApp connection gets its own webhook URL,
-- and routes/webhooks.py::_handle_whatsapp resolves a delivery by that path
-- token first — which is unambiguous. But it FALLS BACK to _conn_by_account,
-- which looks the connection up by the phone_number_id in the payload alone,
-- with `LIMIT 1` and no ordering. That fallback exists for the bare
-- /ext/whatsapp/webhook path kept working for pre-existing setups, and for the
-- deployment-wide whatsapp_app_secret.
--
-- uq_integration_conn_account is unique per (org_id, provider,
-- external_account_id_bidx) — i.e. it happily allows two DIFFERENT orgs to hold
-- the same phone_number_id. Down that fallback path, whichever row the planner
-- returned first would receive the other workspace's messages.
--
-- Meta guarantees a phone_number_id belongs to exactly one WhatsApp Business
-- Account, so global uniqueness is a true statement about the world, not a
-- policy we are imposing. Scoped to whatsapp because it is not true of the
-- other providers: a Slack team id or a mailbox can legitimately be connected
-- by two different workspaces.
--
-- Safe to build: production held zero integration_connections rows when this
-- landed. If it ever fails on an existing deployment, that failure IS the
-- finding — two orgs really are claiming the same business number, and the
-- deploy should stop until someone decides which one owns it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_account_global
    ON integration_connections (external_account_id_bidx)
    WHERE provider = 'whatsapp'
      AND external_account_id_bidx IS NOT NULL
      AND status <> 'revoked';

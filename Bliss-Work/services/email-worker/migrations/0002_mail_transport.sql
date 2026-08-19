-- 0002_mail_transport.sql ─ which way one mail actually left the deployment.
--
-- A mail addressed to several people outside the org arrives here as one event
-- per address, because that is what SMTP needs: one envelope recipient per
-- copy, with the shared To/Cc header, which is what keeps a Bcc'd address out
-- of everybody's headers.
--
-- Sending through the author's OWN mailbox cannot work that way. A mailbox
-- provider has no envelope of its own — it delivers to exactly the addresses in
-- the headers it is handed — so ONE send covers every external recipient, and
-- the remaining copies must do nothing at all. They cannot work that out from
-- their own payload: whether the provider send happened depends on whether the
-- author had a usable mailbox, which is only known once it has been tried.
--
-- So the copy that tries it (events.MailOutbound.ProviderCopy) records the
-- answer here, and the others read it. Written only AFTER the outcome is known,
-- which is what makes a crash safe: no row means the deciding copy never
-- finished, its Kafka offset was never committed, and it is simply retried.
CREATE TABLE IF NOT EXISTS mail_transport (
    mail_id    uuid        PRIMARY KEY,
    -- 'provider' — one send through the author's mailbox already covered every
    --              external recipient; the other copies have nothing to do.
    -- 'relay'    — no usable mailbox (or the mail would not fit through it), so
    --              every copy goes out over SMTP as it always did.
    transport  text        NOT NULL CHECK (transport IN ('provider', 'relay')),
    decided_at timestamptz NOT NULL DEFAULT now()
);

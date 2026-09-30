ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS channel_id uuid NULL;
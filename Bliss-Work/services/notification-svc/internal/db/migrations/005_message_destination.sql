ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS conversation_id uuid NULL,
    ADD COLUMN IF NOT EXISTS message_id uuid NULL;
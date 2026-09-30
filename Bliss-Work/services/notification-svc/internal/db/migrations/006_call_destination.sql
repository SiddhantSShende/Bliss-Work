ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS call_id uuid NULL;
-- Message kind: distinguishes a system-generated entry from something a person
-- typed. Added for missed calls — the chat thread has to show "Missed call"
-- without it being indistinguishable from the caller literally typing that, and
-- without a client being able to fake one by choosing the right words.
--
-- Additive and defaulted, so every existing row and every producer that does not
-- know about the column keeps working unchanged ('text' = an ordinary message).
-- The write path whitelists the values it accepts; this column is not a free
-- text field for clients.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';

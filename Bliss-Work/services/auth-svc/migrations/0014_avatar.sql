-- 0014_avatar — profile picture, encrypted at rest like email/display_name.
--
-- Stores the whole `data:image/webp;base64,...` string ciphertext, not a
-- separate blob/attachment row: a profile picture is small (client-resized
-- before upload — see lib/thumbnail.ts), rarely changes, and needs to travel
-- embedded in UserDTO/MemberDTO wherever those already flow, with no signed-URL
-- refresh problem to solve. See 0002_column_encryption.sql for the same
-- per-org DEK this reuses via `avatar_enc`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_enc bytea;

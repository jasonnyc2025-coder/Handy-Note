-- 002: Thai flashcards ride along in the same per-user data row.
-- thai_rev is a monotonic revision used for last-write-wins sync.

ALTER TABLE user_data ADD COLUMN IF NOT EXISTS thai     JSONB  NOT NULL DEFAULT '[]';
ALTER TABLE user_data ADD COLUMN IF NOT EXISTS thai_rev BIGINT NOT NULL DEFAULT 0;

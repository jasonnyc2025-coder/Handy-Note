-- Voice/Siri quick-add: a per-user, write-only token used by an iOS Shortcut
-- to append a note without exposing the full-access login JWT. It can be reset
-- from the app, which instantly invalidates the old one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS quick_add_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_quick_add_token
  ON users (quick_add_token) WHERE quick_add_token IS NOT NULL;

-- Link push subscriptions to a user so a note added by voice/Siri can inject
-- its reminder straight into that user's devices' push queue — making it fire
-- in the background even if the app is never opened.
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices (user_id);

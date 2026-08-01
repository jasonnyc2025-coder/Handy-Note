-- Background push reminders.
--
-- Devices register anonymously (no user account needed) keyed by their push
-- subscription endpoint, and upload the reminders they want delivered. A
-- server-side scheduler sends a Web Push when a reminder comes due, so the
-- reminder fires even when the app is fully closed.

-- Small key/value store for server settings — used to persist the VAPID
-- keypair so it stays stable across restarts (regenerating it would
-- invalidate every existing push subscription).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_devices (
  endpoint     TEXT PRIMARY KEY,
  subscription JSONB NOT NULL,
  reminders    JSONB NOT NULL DEFAULT '[]',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

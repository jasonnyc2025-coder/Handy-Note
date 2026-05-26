CREATE TABLE IF NOT EXISTS sync_rooms (
  room        TEXT PRIMARY KEY,
  notes       JSONB NOT NULL DEFAULT '[]',
  cats        JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

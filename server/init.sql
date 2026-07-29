-- Users authenticated via Google OAuth
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT,
  name        TEXT,
  picture     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One data row per user (notes + categories + Thai flashcards)
CREATE TABLE IF NOT EXISTS user_data (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notes       JSONB  NOT NULL DEFAULT '[]',
  cats        JSONB  NOT NULL DEFAULT '[]',
  thai        JSONB  NOT NULL DEFAULT '[]',
  thai_rev    BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration for existing databases (safe to run repeatedly)
ALTER TABLE user_data ADD COLUMN IF NOT EXISTS thai     JSONB  NOT NULL DEFAULT '[]';
ALTER TABLE user_data ADD COLUMN IF NOT EXISTS thai_rev BIGINT NOT NULL DEFAULT 0;

-- Users authenticated via Google OAuth
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT,
  name        TEXT,
  picture     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One data row per user (notes + categories)
CREATE TABLE IF NOT EXISTS user_data (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notes       JSONB NOT NULL DEFAULT '[]',
  cats        JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

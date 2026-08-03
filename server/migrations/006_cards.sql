-- 006: Business-card holder (名片夹).
-- Card metadata + small thumbnails ride in a JSONB column with a monotonic rev,
-- exactly like the Thai flashcards (last-write-wins). Full-resolution photos are
-- kept in their own table so the metadata sync stays light and the originals can
-- be downloaded lazily, per card, on a fresh device.
ALTER TABLE user_data ADD COLUMN IF NOT EXISTS cards     JSONB  NOT NULL DEFAULT '[]';
ALTER TABLE user_data ADD COLUMN IF NOT EXISTS cards_rev BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS card_images (
  user_id    INTEGER     NOT NULL,
  card_id    TEXT        NOT NULL,
  side       TEXT        NOT NULL DEFAULT 'front',   -- 'front' | 'back'
  mime       TEXT        NOT NULL DEFAULT 'image/jpeg',
  data       BYTEA       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id, side)
);

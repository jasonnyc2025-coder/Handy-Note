-- 008: shared staff bonus / raise ledger (used by the separate staff-bonus app)
--
-- A "book" is one shared ledger. Members are listed by Google email; a member
-- who is not in ALLOWED_EMAILS can still sign in, but only gets a bonus-scoped
-- token that the notes/thai/cards endpoints reject.

CREATE TABLE IF NOT EXISTS bonus_books (
  id          SERIAL PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '员工奖金',
  rev         BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bonus_members (
  book_id     INTEGER NOT NULL REFERENCES bonus_books(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,              -- lower-case
  role        TEXT NOT NULL DEFAULT 'editor',  -- 'owner' | 'editor'
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (book_id, email)
);
CREATE INDEX IF NOT EXISTS bonus_members_email ON bonus_members (email);

-- One row per record: employees ("emp:<id>") and employee-years ("yr:<empId>:<year>").
CREATE TABLE IF NOT EXISTS bonus_records (
  book_id     INTEGER NOT NULL REFERENCES bonus_books(id) ON DELETE CASCADE,
  rec_id      TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  rev         BIGINT NOT NULL,
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_by TEXT,
  PRIMARY KEY (book_id, rec_id)
);
CREATE INDEX IF NOT EXISTS bonus_records_rev ON bonus_records (book_id, rev);

-- Who changed what, field by field.
CREATE TABLE IF NOT EXISTS bonus_log (
  id          BIGSERIAL PRIMARY KEY,
  book_id     INTEGER NOT NULL REFERENCES bonus_books(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email       TEXT,
  name        TEXT,
  rec_id      TEXT NOT NULL,
  action      TEXT NOT NULL,              -- 'create' | 'update' | 'delete'
  changes     JSONB NOT NULL DEFAULT '{}' -- { field: [old, new] }
);
CREATE INDEX IF NOT EXISTS bonus_log_book ON bonus_log (book_id, id DESC);

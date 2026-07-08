// SQLite DDL for the storage layer (specs/data-model.md §1–3). Only the
// fields the current domain types need; amounts are INTEGER minor units (#6).

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS currencies (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  scale      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (group_id, code)
);

CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id),
  currency_id      TEXT NOT NULL REFERENCES currencies(id),
  type             TEXT NOT NULL,
  member_id        TEXT,
  counterparty_ref TEXT,
  created_at       TEXT NOT NULL,
  closed_at        TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id),
  type             TEXT NOT NULL,
  flow             TEXT,
  state            TEXT NOT NULL,
  seq              INTEGER,
  hash             TEXT,
  hash_version     INTEGER,
  description      TEXT,
  reference        TEXT,
  created_by       TEXT NOT NULL,
  channel          TEXT NOT NULL,
  reverses_id      TEXT,
  demurrage_run_id TEXT,
  remote_ref       TEXT,
  api_token_id     TEXT,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL,
  committed_at     TEXT,
  expires_at       TEXT,
  UNIQUE (group_id, idempotency_key),
  UNIQUE (group_id, seq)
);

CREATE TABLE IF NOT EXISTS entries (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  amount         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_transaction ON entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_entries_account ON entries(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_group_seq ON transactions(group_id, seq);
`;

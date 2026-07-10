// SQLite DDL for the storage layer (specs/data-model.md). Only the fields
// the current domain types need; amounts are INTEGER minor units (#6).
// This is migration 1 (see migrations.ts) and runs exactly once per database,
// so no IF NOT EXISTS guards.

export const SCHEMA = `
-- Tenancy (#2): groups are tenants; group_domains maps hostnames to them.
CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active', -- active | suspended (#20)
  plan       TEXT, -- operator's plan label (#20)
  notes      TEXT, -- operator-private free text (#20)
  email_from TEXT,
  settings   TEXT, -- GroupSettings JSON; NULL = all platform defaults
  qr_secret  TEXT NOT NULL, -- payment-request signing key (#22); never leaves the server
  created_at TEXT NOT NULL
);

CREATE TABLE group_domains (
  hostname TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id)
);

-- Identity (#2, data-model §1): users are global, members are per-group
-- (linked via persons.user_id); sessions are server-side and revocable with
-- the token sha256-hashed at rest. Operators are users, not members; the
-- flag gates the provisioning API.
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  status            TEXT NOT NULL,
  is_operator       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  last_login_at     TEXT,
  email_verified_at TEXT
);

-- Membership (#7): lifecycle in status, group-level role.
CREATE TABLE members (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id),
  member_no        INTEGER NOT NULL,
  type             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member',
  status           TEXT NOT NULL,
  confirm_incoming INTEGER NOT NULL DEFAULT 0,
  digest_frequency TEXT NOT NULL DEFAULT 'weekly',
  applied_at       TEXT NOT NULL,
  approved_at      TEXT,
  closed_at        TEXT,
  UNIQUE (group_id, member_no)
);

CREATE TABLE persons (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  user_id    TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  email      TEXT
);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  member_id        TEXT REFERENCES members(id),
  acting_member_id TEXT REFERENCES members(id), /* admin acts-for-member (#24) */
  token_hash       TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  revoked_at       TEXT
);

-- One-time tokens (data-model §1): single-use expiring links for password
-- reset and email verification ('invite' reserved), sha256-hashed at rest
-- like sessions. user_id is nullable for invites sent before a user exists.
CREATE TABLE one_time_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Currencies and demurrage (#1): marginal bands per currency, idempotent
-- monthly runs; demurrage_day null means demurrage off.
CREATE TABLE currencies (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  scale         INTEGER NOT NULL DEFAULT 0,
  demurrage_day INTEGER,
  created_at    TEXT NOT NULL,
  UNIQUE (group_id, code)
);

CREATE TABLE demurrage_bands (
  currency_id        TEXT NOT NULL REFERENCES currencies(id),
  from_amount        INTEGER NOT NULL,
  rate_ppm_per_month INTEGER NOT NULL,
  UNIQUE (currency_id, from_amount)
);

CREATE TABLE demurrage_runs (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id),
  currency_id  TEXT NOT NULL REFERENCES currencies(id),
  period       TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (currency_id, period)
);

-- Ledger (#6, #10): append-only double-entry journal; committed transactions
-- carry a per-group seq and hash chain. member_id on accounts is deliberately
-- loose (no FK) so the ledger contract can use synthetic member ids.
CREATE TABLE accounts (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id),
  currency_id      TEXT NOT NULL REFERENCES currencies(id),
  type             TEXT NOT NULL,
  member_id        TEXT,
  counterparty_ref TEXT,
  created_at       TEXT NOT NULL,
  closed_at        TEXT
);

CREATE TABLE transactions (
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

CREATE TABLE entries (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  amount         INTEGER NOT NULL
);

-- Credit control (#3): pluggable policies (opaque JSON config) plus the
-- manual restriction lever.
CREATE TABLE credit_policies (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  currency_id TEXT NOT NULL REFERENCES currencies(id),
  type        TEXT NOT NULL,
  config      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE restrictions (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  reason     TEXT NOT NULL,
  imposed_by TEXT NOT NULL,
  imposed_at TEXT NOT NULL,
  lifted_by  TEXT,
  lifted_at  TEXT
);

-- Marketplace (data-model §5).
CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  group_id  TEXT NOT NULL REFERENCES groups(id),
  name      TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id),
  UNIQUE (group_id, parent_id, name)
);

CREATE TABLE listings (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES groups(id),
  member_id         TEXT NOT NULL REFERENCES members(id),
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  category_id       TEXT NOT NULL REFERENCES categories(id),
  price_amount      INTEGER,
  price_currency_id TEXT,
  rate_text         TEXT,
  status            TEXT NOT NULL,
  expires_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- API tokens (#9, data-model §7): a token acts as one membership with
-- member-granted scopes; the raw value is sha256-hashed at rest like
-- sessions. No FK on member_id — like accounts, member linkage is loose so
-- the ledger contract can use synthetic member ids. Rolling spend is derived
-- from transactions.api_token_id, so no counter column here.
CREATE TABLE api_tokens (
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  label             TEXT NOT NULL,
  scopes            TEXT NOT NULL,
  max_tx_amount     INTEGER,
  max_period_amount INTEGER,
  period_days       INTEGER,
  expires_at        TEXT,
  revoked_at        TEXT,
  last_used_at      TEXT,
  created_at        TEXT NOT NULL
);

-- Outbound email log (data-model §6): dedup_key makes enqueueing idempotent
-- so sweeps never double-send. person_id is deliberately loose (no FK), like
-- accounts.member_id, so tests and tooling can use synthetic person ids.
CREATE TABLE email_events (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  person_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  dedup_key  TEXT NOT NULL UNIQUE,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  from_email TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Email template overrides (#16): a row overrides the built-in default for
-- (group, kind); deleting it reverts. Defaults live in code, never seeded.
CREATE TABLE email_templates (
  id       TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  kind     TEXT NOT NULL,
  subject  TEXT NOT NULL,
  body     TEXT NOT NULL,
  UNIQUE (group_id, kind)
);

-- CMS pages (decision #13, data-model §6): body is markdown source; slug is
-- unique per group so each page has one stable URL within its tenant.
CREATE TABLE pages (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  visibility TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (group_id, slug)
);

-- News items (decision #13, data-model §6): the community noticeboard.
-- Always public; current between published_at and expires_at (if set).
-- body is markdown source.
CREATE TABLE news_items (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  published_at TEXT NOT NULL,
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Images (decision #14): one general blob store behind opaque uuids — the
-- bytes live in the blob column and only ever leave storage via imageData;
-- metadata queries must not touch it. owner_id is deliberately loose (no
-- FK), like accounts.member_id: cms images have no owner row at all.
CREATE TABLE images (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  owner_kind TEXT NOT NULL,
  owner_id   TEXT,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  blob       BLOB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Audit trail (data-model §8): append-only — rows are only ever inserted,
-- never updated or deleted. group_id is nullable for platform-level events;
-- actor ids are deliberately loose (no FK), like accounts.member_id, so
-- system events and tests can use synthetic ids. detail is opaque JSON.
CREATE TABLE audit_events (
  id                   TEXT PRIMARY KEY,
  group_id             TEXT REFERENCES groups(id),
  actor_user_id        TEXT,
  acting_for_member_id TEXT,
  action               TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            TEXT NOT NULL,
  detail               TEXT, /* JSON */
  at                   TEXT NOT NULL
);

-- Generic search (data-model Search interface): one FTS5 index over every
-- searchable domain, kept in sync by the triggers below. Deliberately no
-- status/visibility here — tier rules live in search()'s JOIN back to the
-- source table, so a status flip needs no index write.
CREATE VIRTUAL TABLE search_index USING fts5(
  title, body, domain UNINDEXED, entity_id UNINDEXED, group_id UNINDEXED
);

CREATE TRIGGER listings_search_ai AFTER INSERT ON listings BEGIN
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.title, new.description, 'listings', new.id, new.group_id);
END;
CREATE TRIGGER listings_search_au AFTER UPDATE ON listings BEGIN
  DELETE FROM search_index WHERE domain = 'listings' AND entity_id = old.id;
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.title, new.description, 'listings', new.id, new.group_id);
END;
CREATE TRIGGER listings_search_ad AFTER DELETE ON listings BEGIN
  DELETE FROM search_index WHERE domain = 'listings' AND entity_id = old.id;
END;

CREATE TRIGGER members_search_ai AFTER INSERT ON members BEGIN
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.display_name, '', 'directory', new.id, new.group_id);
END;
CREATE TRIGGER members_search_au AFTER UPDATE ON members BEGIN
  DELETE FROM search_index WHERE domain = 'directory' AND entity_id = old.id;
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.display_name, '', 'directory', new.id, new.group_id);
END;
CREATE TRIGGER members_search_ad AFTER DELETE ON members BEGIN
  DELETE FROM search_index WHERE domain = 'directory' AND entity_id = old.id;
END;

CREATE TRIGGER pages_search_ai AFTER INSERT ON pages BEGIN
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.title, new.body, 'pages', new.id, new.group_id);
END;
CREATE TRIGGER pages_search_au AFTER UPDATE ON pages BEGIN
  DELETE FROM search_index WHERE domain = 'pages' AND entity_id = old.id;
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.title, new.body, 'pages', new.id, new.group_id);
END;
CREATE TRIGGER pages_search_ad AFTER DELETE ON pages BEGIN
  DELETE FROM search_index WHERE domain = 'pages' AND entity_id = old.id;
END;

CREATE TRIGGER news_items_search_ai AFTER INSERT ON news_items BEGIN
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.title, new.body, 'news', new.id, new.group_id);
END;
CREATE TRIGGER news_items_search_au AFTER UPDATE ON news_items BEGIN
  DELETE FROM search_index WHERE domain = 'news' AND entity_id = old.id;
  INSERT INTO search_index (title, body, domain, entity_id, group_id)
  VALUES (new.title, new.body, 'news', new.id, new.group_id);
END;
CREATE TRIGGER news_items_search_ad AFTER DELETE ON news_items BEGIN
  DELETE FROM search_index WHERE domain = 'news' AND entity_id = old.id;
END;

CREATE INDEX idx_entries_transaction ON entries(transaction_id);
CREATE INDEX idx_entries_account ON entries(account_id);
CREATE INDEX idx_transactions_group_seq ON transactions(group_id, seq);
CREATE INDEX idx_members_group ON members(group_id);
CREATE INDEX idx_persons_member ON persons(member_id);
CREATE INDEX idx_persons_user ON persons(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_restrictions_member ON restrictions(member_id);
CREATE INDEX idx_listings_group_status ON listings(group_id, status);
CREATE INDEX idx_api_tokens_member ON api_tokens(member_id);
-- Partial index matching the pending-delivery query exactly.
CREATE INDEX idx_email_events_pending ON email_events(created_at)
  WHERE sent_at IS NULL AND attempts < 3;
-- Matches the listPages ordering (position, then slug).
CREATE INDEX idx_pages_group_position ON pages(group_id, position);
-- Matches the listNews ordering (newest publishedAt first) per group.
CREATE INDEX idx_news_items_group_published ON news_items(group_id, published_at DESC);
-- Matches the listImages filter (group, then owner kind/id) (#14).
CREATE INDEX idx_images_group_owner ON images(group_id, owner_kind, owner_id);
-- Matches the listAuditEvents ordering (newest first) per group (§8).
CREATE INDEX idx_audit_events_group_at ON audit_events(group_id, at);
`;

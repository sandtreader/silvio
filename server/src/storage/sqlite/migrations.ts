// Versioned schema migrations. Each migration runs once, inside its own
// transaction, and is recorded in schema_version so reopening a database
// never re-executes DDL. Opening a database stamped with a version newer
// than the highest migration here is refused: a future schema may not be
// readable by this build.

import type Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

export interface Migration {
  version: number;
  sql: string;
}

// Migration 2: demurrage config and runs (decision #1).
const DEMURRAGE_SCHEMA = `
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
`;

// Migration 3: membership, credit control, and marketplace (decisions #3, #7).
const DOMAIN_SCHEMA = `
CREATE TABLE members (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups(id),
  member_no        INTEGER NOT NULL,
  type             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  status           TEXT NOT NULL,
  confirm_incoming INTEGER NOT NULL DEFAULT 0,
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

CREATE INDEX idx_members_group ON members(group_id);
CREATE INDEX idx_persons_member ON persons(member_id);
CREATE INDEX idx_restrictions_member ON restrictions(member_id);
CREATE INDEX idx_listings_group_status ON listings(group_id, status);
`;

// Migration 4: per-currency demurrage posting day (decision #1, scheduler).
const SCHEDULER_SCHEMA = `
ALTER TABLE currencies ADD COLUMN demurrage_day INTEGER;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: SCHEMA },
  { version: 2, sql: DEMURRAGE_SCHEMA },
  { version: 3, sql: DOMAIN_SCHEMA },
  { version: 4, sql: SCHEDULER_SCHEMA },
];

export function migrate(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get() as { version: number | null };
  const current = row.version ?? 0;
  const max = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (current > max) {
    throw new Error(
      `database schema version ${current} is newer than this build (max ${max})`,
    );
  }
  const insert = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, new Date().toISOString());
    })();
  }
}

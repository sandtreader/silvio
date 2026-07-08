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

export const MIGRATIONS: Migration[] = [{ version: 1, sql: SCHEMA }];

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

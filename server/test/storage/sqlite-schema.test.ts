// SQLite-specific: schema persistence and versioned migrations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';

describe('SqliteStorage schema lifecycle', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'silvio-test-'));
    path = join(dir, 'test.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists data across close/reopen without recreating the schema', async () => {
    const s1 = new SqliteStorage(path);
    const group = await s1.createGroup({ slug: 'g', name: 'G' });
    const cams = await s1.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams' });
    const a = await s1.createAccount({ groupId: group.id, currencyId: cams.id, type: 'member' });
    const b = await s1.createAccount({ groupId: group.id, currencyId: cams.id, type: 'member' });
    await s1.post({
      groupId: group.id,
      type: 'trade',
      state: 'committed',
      createdBy: 'p',
      channel: 'web',
      entries: [
        { accountId: a.id, amount: -42 },
        { accountId: b.id, amount: 42 },
      ],
    });
    s1.close();

    const s2 = new SqliteStorage(path);
    expect(await s2.balance(a.id)).toBe(-42);
    expect((await s2.verify(group.id)).ok).toBe(true);
    s2.close();
  });

  it('stamps the schema version in a version table', () => {
    const s = new SqliteStorage(path);
    s.close();
    const db = new Database(path);
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    };
    db.close();
    expect(row.version).toBe(1);
  });

  it('refuses to open a database with a newer schema version', () => {
    const s = new SqliteStorage(path);
    s.close();
    const db = new Database(path);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      999,
      new Date().toISOString(),
    );
    db.close();
    expect(() => new SqliteStorage(path)).toThrow(/schema version/i);
  });
});

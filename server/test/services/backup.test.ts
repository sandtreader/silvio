// Scheduled backups (todo: Operator & deployment). SQLite's online backup
// API via better-sqlite3 — safe against a live database, one file is the
// whole state (blobs included). Daily file per UTC date, integrity-checked
// after writing, rotated: the newest 7 dailies plus the newest 4
// Monday-dated files survive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runBackup } from '../../src/services/backup.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';

describe('backups', () => {
  let storage: SqliteStorage;
  let dir: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    dir = mkdtempSync(join(tmpdir(), 'silvio-backup-'));
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('storage.backup writes a real, openable copy of the whole database', async () => {
    const dest = join(dir, 'copy.sqlite');
    await storage.backup(dest);
    const copy = new Database(dest, { readonly: true });
    try {
      const row = copy.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number };
      expect(row.n).toBe(1);
      const check = copy.pragma('integrity_check') as { integrity_check: string }[];
      expect(check[0]!.integrity_check).toBe('ok');
    } finally {
      copy.close();
    }
  });

  it('runBackup writes one file per UTC day, idempotently', async () => {
    const first = await runBackup(storage, dir, '2026-07-10T03:00:00.000Z');
    expect(first.created).toBe(true);
    expect(readdirSync(dir)).toEqual(['silvio-2026-07-10.sqlite']);

    const again = await runBackup(storage, dir, '2026-07-10T14:00:00.000Z');
    expect(again.created).toBe(false);
    expect(readdirSync(dir)).toHaveLength(1);

    await runBackup(storage, dir, '2026-07-11T03:00:00.000Z');
    expect(readdirSync(dir).sort()).toEqual([
      'silvio-2026-07-10.sqlite',
      'silvio-2026-07-11.sqlite',
    ]);
  });

  it('rotation keeps the newest 7 dailies plus the newest 4 Mondays', async () => {
    // Seed a backlog: every day from 2026-06-15 (a Monday) to 2026-07-09.
    for (let day = Date.parse('2026-06-15'); day <= Date.parse('2026-07-09'); day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      writeFileSync(join(dir, `silvio-${date}.sqlite`), 'stale');
    }
    // Unrelated files are never touched.
    writeFileSync(join(dir, 'notes.txt'), 'keep me');

    const report = await runBackup(storage, dir, '2026-07-10T03:00:00.000Z'); // a Friday
    expect(report.created).toBe(true);
    expect(report.pruned).toBeGreaterThan(0);

    const kept = readdirSync(dir).sort();
    expect(kept).toEqual([
      'notes.txt',
      // The newest 4 Mondays (2026-07-06 is also inside the newest 7)...
      'silvio-2026-06-15.sqlite',
      'silvio-2026-06-22.sqlite',
      'silvio-2026-06-29.sqlite',
      // ...and the newest 7 dailies including today's new file.
      'silvio-2026-07-04.sqlite',
      'silvio-2026-07-05.sqlite',
      'silvio-2026-07-06.sqlite',
      'silvio-2026-07-07.sqlite',
      'silvio-2026-07-08.sqlite',
      'silvio-2026-07-09.sqlite',
      'silvio-2026-07-10.sqlite',
    ]);
  });

  it('a copy that fails the integrity check is deleted and alerted, loudly', async () => {
    // Force the check to fail by pointing it at a pre-existing garbage file
    // for a *different* day and asking runBackup to verify today's: instead,
    // simulate via the injectable check hook.
    const alerts: string[] = [];
    const report = await runBackup(storage, dir, '2026-07-10T03:00:00.000Z', {
      alert: (message) => alerts.push(message),
      verifyCopy: () => 'file is garbage',
    });
    expect(report.created).toBe(false);
    expect(alerts.some((a) => a.includes('BACKUP'))).toBe(true);
    expect(readdirSync(dir)).toEqual([]); // the bad copy is not left behind
  });
});

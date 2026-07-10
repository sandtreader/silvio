// Scheduled backups (todo: Operator & deployment): one integrity-checked
// SQLite copy per UTC day, written via a temp file so a bad copy never
// lands under a daily name. Rotation keeps the newest 7 dailies plus the
// newest 4 Monday-dated files. runBackup takes `now` explicitly;
// startBackups is the thin wall-clock shim.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage } from '../storage/interface.js';

export interface BackupReport {
  created: boolean;
  pruned: number;
}

export interface BackupOptions {
  alert?: (message: string) => void;
  /** Returns an error string, or undefined when the copy is sound. */
  verifyCopy?: (path: string) => string | undefined;
}

const BACKUP_FILE = /^silvio-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/** Open the copy readonly and PRAGMA integrity_check it. */
function defaultVerifyCopy(path: string): string | undefined {
  try {
    const copy = new Database(path, { readonly: true });
    try {
      const rows = copy.pragma('integrity_check') as { integrity_check: string }[];
      const result = rows.map((r) => r.integrity_check).join('; ');
      return result === 'ok' ? undefined : result;
    } finally {
      copy.close();
    }
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Keep the union of the 7 newest dailies and the 4 newest Mondays (UTC). */
function rotate(dir: string): number {
  const dates = readdirSync(dir)
    .map((name) => BACKUP_FILE.exec(name)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort()
    .reverse();
  const keep = new Set(dates.slice(0, 7));
  const mondays = dates.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1);
  for (const monday of mondays.slice(0, 4)) keep.add(monday);

  let pruned = 0;
  for (const date of dates) {
    if (keep.has(date)) continue;
    rmSync(join(dir, `silvio-${date}.sqlite`));
    pruned += 1;
  }
  return pruned;
}

export async function runBackup(
  storage: Storage,
  dir: string,
  nowIso: string,
  opts?: BackupOptions,
): Promise<BackupReport> {
  const alert = opts?.alert ?? console.error;
  const verifyCopy = opts?.verifyCopy ?? defaultVerifyCopy;
  const date = new Date(nowIso).toISOString().slice(0, 10);

  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `silvio-${date}.sqlite`);
  // The hourly job makes an existing daily file the common case.
  if (existsSync(finalPath)) return { created: false, pruned: 0 };

  const tempPath = join(dir, `.silvio-${date}.sqlite.tmp`);
  await storage.backup(tempPath);
  const error = verifyCopy(tempPath);
  // The backup/verify connections leave empty -shm/-wal sidecars against the
  // temp name (the copy inherits the source's WAL mode); with every
  // connection closed they carry nothing and would otherwise litter the
  // backups directory forever.
  const dropSidecars = (): void => {
    rmSync(`${tempPath}-shm`, { force: true });
    rmSync(`${tempPath}-wal`, { force: true });
  };
  if (error !== undefined) {
    rmSync(tempPath, { force: true });
    dropSidecars();
    alert(`BACKUP FAILED: copy for ${date} failed verification (${error}) — deleted`);
    return { created: false, pruned: 0 };
  }
  renameSync(tempPath, finalPath);
  dropSidecars();
  return { created: true, pruned: rotate(dir) };
}

/** Wall-clock wiring: real deployments call this once at boot. */
export function startBackups(storage: Storage, dir: string, intervalMs = 3_600_000): () => void {
  const run = (): void => {
    runBackup(storage, dir, new Date().toISOString()).catch((err: unknown) => {
      console.error('BACKUP FAILED:', err);
    });
  };
  run(); // pick up a missed day immediately after a restart
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}

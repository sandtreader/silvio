// Manual backup entry point (npm run backup) for pre-upgrade snapshots:
// one runBackup against SILVIO_DB into SILVIO_BACKUP_DIR, then exit —
// non-zero if the copy failed. Wiring only, like index.ts.

import { SqliteStorage } from './storage/sqlite/index.js';
import { runBackup } from './services/backup.js';

const dbPath = process.env['SILVIO_DB'] ?? 'silvio.sqlite';
const dir = process.env['SILVIO_BACKUP_DIR'] ?? './backups';

const storage = new SqliteStorage(dbPath);
let failed = false;
try {
  const report = await runBackup(storage, dir, new Date().toISOString(), {
    alert: (message) => {
      failed = true;
      console.error(message);
    },
  });
  if (!failed) {
    console.log(
      report.created
        ? `backup of ${dbPath} written to ${dir} (pruned ${report.pruned})`
        : `backup for today already exists in ${dir}`,
    );
  }
} finally {
  storage.close();
}
if (failed) process.exit(1);

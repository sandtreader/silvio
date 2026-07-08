// Server entrypoint: configuration from environment, wiring storage, the
// REST API and the scheduler. All logic lives in the layers below; keep
// this file to wiring only.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStorage } from './storage/sqlite/index.js';
import { buildApp, type BuildAppOptions } from './api/app.js';
import { bootstrapOperator } from './services/bootstrap.js';
import { startScheduler } from './services/scheduler.js';
import { promptOperatorCredentials } from './prompt.js';

const dbPath = process.env['SILVIO_DB'] ?? 'silvio.sqlite';
// Default port 1862: Silvio Gesell's year of birth.
const port = Number(process.env['SILVIO_PORT'] ?? 1862);
const host = process.env['SILVIO_HOST'] ?? '0.0.0.0';

const storage = new SqliteStorage(dbPath);

// First-boot operator bootstrap (idempotent): env vars if set, an
// interactive prompt on a TTY, otherwise a loud hint — never a hang.
if (!(await storage.operatorExists())) {
  const email = process.env['SILVIO_OPERATOR_EMAIL'];
  const password = process.env['SILVIO_OPERATOR_PASSWORD'];
  if (email !== undefined && password !== undefined) {
    await bootstrapOperator(storage, { email, password });
    console.log(`operator ${email} bootstrapped from environment`);
  } else if (process.stdin.isTTY) {
    await bootstrapOperator(storage, await promptOperatorCredentials());
    console.log('operator bootstrapped');
  } else {
    console.warn(
      'WARNING: no operator exists and no TTY to prompt on — set ' +
        'SILVIO_OPERATOR_EMAIL and SILVIO_OPERATOR_PASSWORD to bootstrap one',
    );
  }
}
// Serve built UIs when present (decision #11): env override, else the
// sibling ui/ packages' dist directories in the repo layout.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function uiDist(envVar: string, fallback: string): string | undefined {
  const path = process.env[envVar] ?? join(repoRoot, fallback);
  return existsSync(join(path, 'index.html')) ? path : undefined;
}
const ui: NonNullable<BuildAppOptions['ui']> = {};
const memberDist = uiDist('SILVIO_MEMBER_UI', 'ui/member/dist');
const adminDist = uiDist('SILVIO_ADMIN_UI', 'ui/admin/dist');
if (memberDist !== undefined) ui.memberDist = memberDist;
if (adminDist !== undefined) ui.adminDist = adminDist;

const app = await buildApp(storage, { ui });
const stopScheduler = startScheduler(storage);

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  stopScheduler();
  await app.close();
  storage.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port, host });
console.log(`Silvio server listening on ${host}:${port} (db: ${dbPath})`);

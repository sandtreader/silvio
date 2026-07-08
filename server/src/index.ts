// Server entrypoint: configuration from environment, wiring storage, the
// REST API and the scheduler. All logic lives in the layers below; keep
// this file to wiring only.

import { SqliteStorage } from './storage/sqlite/index.js';
import { buildApp } from './api/app.js';
import { startScheduler } from './services/scheduler.js';

const dbPath = process.env['SILVIO_DB'] ?? 'silvio.sqlite';
const port = Number(process.env['SILVIO_PORT'] ?? 3000);
const host = process.env['SILVIO_HOST'] ?? '0.0.0.0';

const storage = new SqliteStorage(dbPath);
const app = await buildApp(storage);
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

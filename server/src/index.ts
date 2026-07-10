// Server entrypoint: configuration from environment and optional config
// file, wiring storage, the REST API and the scheduler. All logic lives in
// the layers below; keep this file to wiring only.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { SqliteStorage } from './storage/sqlite/index.js';
import { buildApp, type BuildAppOptions } from './api/app.js';
import { bootstrapOperator } from './services/bootstrap.js';
import { startBackups } from './services/backup.js';
import { startScheduler } from './services/scheduler.js';
import { createSmtpMailer, startEmailDelivery } from './services/email.js';
import { promptOperatorCredentials } from './prompt.js';

const config = loadConfig(process.env);
const storage = new SqliteStorage(config.db);

// First-boot operator bootstrap (idempotent): env vars if set, an
// interactive prompt on a TTY, otherwise a loud hint — never a hang.
// Console rather than the app logger: the app doesn't exist yet and the
// prompt is interactive.
if (!(await storage.operatorExists())) {
  const { operatorEmail: email, operatorPassword: password } = config;
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
// Serve built UIs when present (decision #11): configured override, else
// the sibling ui/ packages' dist directories in the repo layout.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function uiDist(configured: string | undefined, fallback: string): string | undefined {
  const path = configured ?? join(repoRoot, fallback);
  return existsSync(join(path, 'index.html')) ? path : undefined;
}
const ui: NonNullable<BuildAppOptions['ui']> = {};
const memberDist = uiDist(config.memberUi, 'ui/member/dist');
const adminDist = uiDist(config.adminUi, 'ui/admin/dist');
const operatorDist = uiDist(config.operatorUi, 'ui/operator/dist');
if (memberDist !== undefined) ui.memberDist = memberDist;
if (adminDist !== undefined) ui.adminDist = adminDist;
if (operatorDist !== undefined) ui.operatorDist = operatorDist;

const app = await buildApp(storage, { ui, logger: { level: config.logLevel } });
const alert = (message: string): void => {
  app.log.error(message);
};
const stopScheduler = startScheduler(storage, undefined, { alert });

// Outbound email: with SMTP configured emails are delivered in the
// background; without it they queue in email_events until it is.
let stopEmailDelivery = (): void => {};
if (config.smtpUrl !== undefined && config.emailFrom !== undefined) {
  stopEmailDelivery = startEmailDelivery(
    storage,
    createSmtpMailer(config.smtpUrl, config.emailFrom),
    undefined,
    { alert },
  );
} else {
  app.log.info('SILVIO_SMTP_URL/SILVIO_EMAIL_FROM not set — emails queue but are not sent');
}

// Backups: with a directory configured, one integrity-checked daily copy,
// checked hourly and rotated; without it nothing is backed up.
let stopBackups = (): void => {};
if (config.backupDir !== undefined) {
  stopBackups = startBackups(storage, config.backupDir, undefined, { alert });
  app.log.info(`daily backups on, to ${config.backupDir}`);
} else {
  app.log.info('SILVIO_BACKUP_DIR not set — backups are off');
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  stopScheduler();
  stopEmailDelivery();
  stopBackups();
  await app.close();
  storage.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
app.log.info(`Silvio server listening on ${config.host}:${config.port} (db: ${config.db})`);

// Configuration: an optional JSON file (SILVIO_CONFIG, default ./silvio.json)
// with the same knobs as the env vars. Precedence env > file > defaults.
// An explicit path that is missing, garbage JSON, or an unknown key in the
// file is a loud error — typos must not silently vanish.

import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  db: string;
  port: number;
  host: string;
  logLevel: string;
  operatorEmail?: string;
  operatorPassword?: string;
  smtpUrl?: string;
  emailFrom?: string;
  backupDir?: string;
  memberUi?: string;
  adminUi?: string;
  operatorUi?: string;
}

const STRING_KEYS = [
  'db', 'host', 'logLevel', 'operatorEmail', 'operatorPassword', 'smtpUrl',
  'emailFrom', 'backupDir', 'memberUi', 'adminUi', 'operatorUi',
] as const;
type StringKey = (typeof STRING_KEYS)[number];

const ENV_NAMES: Record<StringKey | 'port', string> = {
  db: 'SILVIO_DB',
  port: 'SILVIO_PORT',
  host: 'SILVIO_HOST',
  logLevel: 'SILVIO_LOG_LEVEL',
  operatorEmail: 'SILVIO_OPERATOR_EMAIL',
  operatorPassword: 'SILVIO_OPERATOR_PASSWORD',
  smtpUrl: 'SILVIO_SMTP_URL',
  emailFrom: 'SILVIO_EMAIL_FROM',
  backupDir: 'SILVIO_BACKUP_DIR',
  memberUi: 'SILVIO_MEMBER_UI',
  adminUi: 'SILVIO_ADMIN_UI',
  operatorUi: 'SILVIO_OPERATOR_UI',
};

function readConfigFile(explicitPath: string | undefined): Record<string, unknown> {
  const path = explicitPath ?? './silvio.json';
  if (!existsSync(path)) {
    if (explicitPath !== undefined) {
      throw new Error(`config file not found: ${explicitPath} (from SILVIO_CONFIG)`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`config file ${path} is not valid JSON: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must be a JSON object`);
  }
  const file = parsed as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (key !== 'port' && !STRING_KEYS.includes(key as StringKey)) {
      throw new Error(`config file ${path}: unknown key '${key}'`);
    }
    const value = file[key];
    if (key === 'port') {
      if (typeof value !== 'number') throw new Error(`config file ${path}: 'port' must be a number`);
    } else if (typeof value !== 'string') {
      throw new Error(`config file ${path}: '${key}' must be a string`);
    }
  }
  return file;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const file = readConfigFile(env['SILVIO_CONFIG']);
  const pick = (key: StringKey): string | undefined =>
    env[ENV_NAMES[key]] ?? (file[key] as string | undefined);

  let port = 1862; // Silvio Gesell's year of birth
  const envPort = env['SILVIO_PORT'];
  if (envPort !== undefined) {
    port = Number(envPort);
    if (!Number.isFinite(port)) throw new Error(`SILVIO_PORT is not a number: ${envPort}`);
  } else if (file['port'] !== undefined) {
    port = file['port'] as number;
  }

  const config: Config = {
    db: pick('db') ?? 'silvio.sqlite',
    port,
    host: pick('host') ?? '0.0.0.0',
    logLevel: pick('logLevel') ?? 'info',
  };
  for (const key of STRING_KEYS) {
    if (key === 'db' || key === 'host' || key === 'logLevel') continue;
    const value = pick(key);
    if (value !== undefined) config[key] = value;
  }
  return config;
}

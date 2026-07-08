// Config dotfile: JSON {server?, group?, cookie?}. Reads are tolerant (a
// missing or malformed file is just {}); writes are pretty-printed and 0o600
// because the file holds a live session cookie.

import { readFileSync, writeFileSync } from 'node:fs';

export interface Config {
  server?: string;
  group?: string;
  cookie?: string;
}

export function readConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const config: Config = {};
  if (typeof record['server'] === 'string') config.server = record['server'];
  if (typeof record['group'] === 'string') config.group = record['group'];
  if (typeof record['cookie'] === 'string') config.cookie = record['cookie'];
  return config;
}

export function writeConfig(path: string, config: Config): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

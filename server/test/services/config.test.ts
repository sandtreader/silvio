// Config file (todo: Operator & deployment): one optional JSON file with
// the same knobs as the env vars; env always wins; missing file with an
// explicit path is a loud error, the default path is allowed to be absent.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeConfig(json: Record<string, unknown>): string {
    dir = mkdtempSync(join(tmpdir(), 'silvio-config-'));
    const path = join(dir, 'silvio.json');
    writeFileSync(path, JSON.stringify(json));
    return path;
  }

  it('defaults apply with no env and no file', () => {
    const config = loadConfig({});
    expect(config.db).toBe('silvio.sqlite');
    expect(config.port).toBe(1862);
    expect(config.host).toBe('0.0.0.0');
    expect(config.smtpUrl).toBeUndefined();
    expect(config.backupDir).toBeUndefined();
  });

  it('the file overrides defaults; env overrides the file', () => {
    const path = writeConfig({
      db: '/data/from-file.sqlite',
      port: 9999,
      smtpUrl: 'smtp://file.example.org',
      emailFrom: 'file@example.org',
      backupDir: '/data/backups',
    });
    const config = loadConfig(
      { SILVIO_CONFIG: path, SILVIO_PORT: '1234', SILVIO_SMTP_URL: 'smtp://env.example.org' },
    );
    expect(config.db).toBe('/data/from-file.sqlite'); // file beats default
    expect(config.port).toBe(1234); // env beats file
    expect(config.smtpUrl).toBe('smtp://env.example.org');
    expect(config.emailFrom).toBe('file@example.org');
    expect(config.backupDir).toBe('/data/backups');
  });

  it('an explicit config path that does not exist throws loudly', () => {
    expect(() => loadConfig({ SILVIO_CONFIG: '/nope/silvio.json' })).toThrow(/config/i);
  });

  it('garbage JSON throws with the path in the message', () => {
    dir = mkdtempSync(join(tmpdir(), 'silvio-config-'));
    const path = join(dir, 'silvio.json');
    writeFileSync(path, '{not json');
    expect(() => loadConfig({ SILVIO_CONFIG: path })).toThrow(new RegExp(path));
  });

  it('unknown keys in the file are refused — typos must not silently vanish', () => {
    const path = writeConfig({ prot: 1234 });
    expect(() => loadConfig({ SILVIO_CONFIG: path })).toThrow(/prot/);
  });
});

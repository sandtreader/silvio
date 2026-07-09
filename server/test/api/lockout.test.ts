// Login lockout through the API: per-email and per-IP sliding windows,
// 429 + Retry-After when locked, success resets the email counter.
//
// Every test here burns real argon2 verifications — fast alone, flaky at
// the default 5s when the whole suite competes for CPU — hence the
// file-wide timeout.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SLOW_HASHING = { timeout: 30_000 };
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { bootstrapOperator } from '../../src/services/bootstrap.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('login lockout', SLOW_HASHING, () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    const user = await register(storage, {
      email: 'alice@example.com',
      password: 'password-alice',
    });
    const applied = await apply(storage, {
      groupId: group.id,
      displayName: 'Alice',
      personName: 'Alice',
      email: 'alice@example.com',
      userId: user.id,
    });
    await approve(storage, applied.member.id);
    await bootstrapOperator(storage, {
      email: 'op@example.com',
      password: 'password-operator',
    });
    app = await buildApp(storage);
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function loginAttempt(email: string, password: string, ip = '198.51.100.1') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST },
      remoteAddress: ip,
      payload: { email, password },
    });
  }

  it('locks an email after 10 failures, even with the right password', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await loginAttempt('alice@example.com', 'wrong-password');
      expect(res.statusCode).toBe(403);
    }
    const locked = await loginAttempt('alice@example.com', 'password-alice');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lockout is per email, not global', async () => {
    for (let i = 0; i < 10; i += 1) {
      await loginAttempt('alice@example.com', 'wrong-password', '203.0.113.7');
    }
    // A different email from a different IP is unaffected.
    const res = await loginAttempt('nobody@example.com', 'whatever', '203.0.113.8');
    expect(res.statusCode).toBe(403); // bad credentials, not 429
  });

  it('a successful login resets the email counter', async () => {
    for (let i = 0; i < 9; i += 1) {
      await loginAttempt('alice@example.com', 'wrong-password');
    }
    const ok = await loginAttempt('alice@example.com', 'password-alice');
    expect(ok.statusCode).toBe(200);
    // Counter cleared: another failure is a 403, not the 10th strike.
    const after = await loginAttempt('alice@example.com', 'wrong-password');
    expect(after.statusCode).toBe(403);
  });

  it('locks an IP hammering many different emails', async () => {
    for (let i = 0; i < 30; i += 1) {
      await loginAttempt(`guess-${i}@example.com`, 'wrong', '192.0.2.99');
    }
    const locked = await loginAttempt('fresh@example.com', 'wrong', '192.0.2.99');
    expect(locked.statusCode).toBe(429);
    // Another IP is unaffected.
    const other = await loginAttempt('fresh@example.com', 'wrong', '192.0.2.100');
    expect(other.statusCode).toBe(403);
  });

  it('throttles operator login by the same rules', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/operator/login',
        remoteAddress: '198.51.100.2',
        payload: { email: 'op@example.com', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(403);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/operator/login',
      remoteAddress: '198.51.100.2',
      payload: { email: 'op@example.com', password: 'password-operator' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('RATE_LIMITED');
  });
});

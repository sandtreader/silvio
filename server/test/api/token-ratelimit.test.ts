// Per-token request rate limiting (decision #9): an agent hammering the
// API gets 429 + Retry-After once it burns its per-minute allowance;
// cookie sessions are untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { issueApiToken } from '../../src/services/tokens.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

describe('per-token rate limiting (#9)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let bob: Member;
  let rawToken: string;
  let bobCookie: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    const cams: Currency = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const user = await register(storage, {
      email: 'bob@example.com', password: 'password-1',
    });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'Bob',
      email: 'bob@example.com', userId: user.id,
    });
    bob = await approve(storage, applied.member.id);
    const persons = await storage.personsForMember(bob.id);
    ({ token: rawToken } = await issueApiToken(storage, {
      memberId: bob.id, createdBy: persons[0]!.id, label: 'agent',
      scopes: ['account:read'],
    }));
    app = await buildApp(storage, { tokenRateLimit: { maxRequests: 5, windowMs: 60_000 } });
    await app.ready();
    const { token } = await login(storage, {
      email: 'bob@example.com', password: 'password-1', groupId: group.id,
    });
    bobCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function meWithToken() {
    return app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/me',
      headers: { authorization: `Bearer ${rawToken}` },
    });
  }

  it('throttles a token past its allowance with 429 + Retry-After', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await meWithToken()).statusCode).toBe(200);
    }
    const limited = await meWithToken();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // The same member's cookie session sails on: the limit is per token.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
  });
});

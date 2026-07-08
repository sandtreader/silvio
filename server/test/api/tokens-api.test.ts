// Token management routes (decision #9): members create, list, and revoke
// their own API tokens from a cookie session. The raw token appears exactly
// once, in the creation response.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('token management API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let alice: Member;
  let bob: Member;
  let aliceCookie: string;
  let bobCookie: string;

  async function makeMember(name: string, email: string): Promise<Member> {
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST },
      payload: { email, password },
    });
    const cookie = res.cookies.find((c) => c.name === 'silvio_session');
    return `silvio_session=${cookie!.value}`;
  }

  function create(cookie: string, payload: object) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { host: HOST, cookie },
      payload,
    });
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    alice = await makeMember('Alice', 'alice@example.com');
    bob = await makeMember('Bob', 'bob@example.com');
    app = await buildApp(storage);
    aliceCookie = await loginCookie('alice@example.com', 'password-Alice');
    bobCookie = await loginCookie('bob@example.com', 'password-Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('creates a token, returning the raw value exactly once', async () => {
    const res = await create(aliceCookie, {
      label: 'my agent', scopes: ['account:read', 'trade:request'],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; apiToken: { id: string; label: string } };
    expect(body.token).toMatch(/^slv_/);
    expect(body.apiToken.label).toBe('my agent');

    // The list never contains the raw value or the hash.
    const list = await app.inject({
      method: 'GET', url: '/api/v1/me/tokens', headers: { host: HOST, cookie: aliceCookie },
    });
    expect(list.statusCode).toBe(200);
    const { tokens } = list.json() as { tokens: Record<string, unknown>[] };
    expect(tokens).toHaveLength(1);
    expect(JSON.stringify(tokens)).not.toContain(body.token);
    expect(Object.keys(tokens[0]!)).not.toContain('tokenHash');
  });

  it('validates: autonomous needs maxTxAmount, scopes must be known', async () => {
    const missing = await create(aliceCookie, {
      label: 'auto', scopes: ['trade:autonomous'],
    });
    expect(missing.statusCode).toBe(400);
    const unknown = await create(aliceCookie, {
      label: 'bad', scopes: ['admin:everything'],
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('lists only the caller’s tokens', async () => {
    await create(aliceCookie, { label: 'alice agent', scopes: ['account:read'] });
    await create(bobCookie, { label: 'bob agent', scopes: ['account:read'] });
    const list = await app.inject({
      method: 'GET', url: '/api/v1/me/tokens', headers: { host: HOST, cookie: aliceCookie },
    });
    const { tokens } = list.json() as { tokens: { label: string }[] };
    expect(tokens.map((t) => t.label)).toEqual(['alice agent']);
  });

  it('revoking kills the token immediately', async () => {
    const res = await create(aliceCookie, { label: 'doomed', scopes: ['account:read'] });
    const { token, apiToken } = res.json() as { token: string; apiToken: { id: string } };

    const before = await app.inject({
      method: 'GET', url: '/api/v1/me',
      headers: { host: HOST, authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({
      method: 'DELETE', url: `/api/v1/me/tokens/${apiToken.id}`,
      headers: { host: HOST, cookie: aliceCookie },
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/api/v1/me',
      headers: { host: HOST, authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('cannot revoke another member’s token', async () => {
    const res = await create(aliceCookie, { label: 'alice agent', scopes: ['account:read'] });
    const { apiToken } = res.json() as { apiToken: { id: string } };
    const revoke = await app.inject({
      method: 'DELETE', url: `/api/v1/me/tokens/${apiToken.id}`,
      headers: { host: HOST, cookie: bobCookie },
    });
    expect([403, 404]).toContain(revoke.statusCode);
    // Still alive.
    const list = await app.inject({
      method: 'GET', url: '/api/v1/me/tokens', headers: { host: HOST, cookie: aliceCookie },
    });
    const { tokens } = list.json() as { tokens: { revokedAt?: string }[] };
    expect(tokens[0]!.revokedAt).toBeUndefined();
  });

  it('tokens cannot manage tokens', async () => {
    const res = await create(aliceCookie, {
      label: 'full', scopes: [
        'marketplace:read', 'directory:read', 'account:read',
        'listings:write', 'trade:request',
      ],
    });
    const { token } = res.json() as { token: string };
    const attempt = await app.inject({
      method: 'POST', url: '/api/v1/me/tokens',
      headers: { host: HOST, authorization: `Bearer ${token}` },
      payload: { label: 'sneaky', scopes: ['trade:autonomous'], maxTxAmount: 1_000_000 },
    });
    expect(attempt.statusCode).toBe(403);
  });
});

// CSRF defence in depth (todo: "CSRF protection for cookie sessions").
// Sessions are SameSite=Lax cookies, which already blocks cross-site POSTs
// in modern browsers; this adds an Origin check on state-changing /api/*
// requests. No Origin header (CLI, curl, server-to-server) is allowed —
// only a *mismatched* browser Origin is rejected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('CSRF origin check', () => {
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
    app = await buildApp(storage);
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function loginAttempt(origin?: string) {
    const headers: Record<string, string> = { host: HOST };
    if (origin !== undefined) headers['origin'] = origin;
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers,
      payload: { email: 'alice@example.com', password: 'password-alice' },
    });
  }

  it('allows a same-origin POST', async () => {
    const res = await loginAttempt(`https://${HOST}`);
    expect(res.statusCode).toBe(200);
  });

  it('allows a POST with no Origin header (CLI, curl)', async () => {
    const res = await loginAttempt();
    expect(res.statusCode).toBe(200);
  });

  it('rejects a cross-origin POST with 403', async () => {
    const res = await loginAttempt('https://evil.example.com');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_AUTHORISED');
  });

  it('rejects Origin: null (sandboxed iframe / data: URL)', async () => {
    const res = await loginAttempt('null');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a same-host different-port origin', async () => {
    const res = await loginAttempt(`https://${HOST}:8443`);
    expect(res.statusCode).toBe(403);
  });

  it('ignores scheme: http origin to https-terminated host is same-origin', async () => {
    // Behind a TLS-terminating proxy the server cannot see the scheme, so
    // only the host part is compared.
    const res = await loginAttempt(`http://${HOST}`);
    expect(res.statusCode).toBe(200);
  });

  it('does not apply to GET requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings',
      headers: { host: HOST, origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('guards state-changing routes with a session cookie too', async () => {
    const login = await loginAttempt();
    const cookie = login.cookies.find((c) => c.name === 'silvio_session');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        host: HOST,
        origin: 'https://evil.example.com',
        cookie: `silvio_session=${cookie!.value}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

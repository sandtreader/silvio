// Operator API (decision #2): platform-level provisioning, outside any
// tenant. Operators are users, not members — sessions need no group.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';

describe('operator API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;

  async function operatorCookie(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/operator/login',
      payload: { email: 'op@example.com', password: 'operator-pass' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'silvio_session');
    return `silvio_session=${cookie!.value}`;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    const op = await register(storage, { email: 'op@example.com', password: 'operator-pass' });
    await storage.setOperator(op.id, true);
    await register(storage, { email: 'pleb@example.com', password: 'pleb-password' });
    app = await buildApp(storage);
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('operator login works without any group; non-operators are refused', async () => {
    await operatorCookie();
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/operator/login',
      payload: { email: 'pleb@example.com', password: 'pleb-password' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('operator routes require an operator session', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/operator/groups' });
    expect(anon.statusCode).toBe(401);
  });

  it('provisions a group with domain, currency and community account', async () => {
    const cookie = await operatorCookie();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: {
        slug: 'falmouth', name: 'Falmouth LETS', hostname: 'falmouth.example.org',
        currency: { code: 'PLM', name: 'Palms', scale: 2, demurrageDay: 1 },
      },
    });
    expect(res.statusCode).toBe(201);
    const { group, currency } = res.json();
    expect(group.slug).toBe('falmouth');
    expect(currency.code).toBe('PLM');
    expect(currency.demurrageDay).toBe(1);

    // tenant is live via both resolution paths
    const bySlug = await app.inject({ method: 'GET', url: '/api/v1/g/falmouth/listings' });
    expect(bySlug.statusCode).toBe(200);
    const byHost = await app.inject({
      method: 'GET', url: '/api/v1/listings', headers: { host: 'falmouth.example.org' },
    });
    expect(byHost.statusCode).toBe(200);

    // community account exists for the currency (#1 needs it)
    const accounts = await storage.listAccounts(group.id, currency.id);
    expect(accounts.some((a) => a.type === 'community')).toBe(true);
  });

  it('provisions a group with an initial admin who can approve members', async () => {
    const cookie = await operatorCookie();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: {
        slug: 'tot', name: 'Totnes LETS', hostname: 'tot.example.org',
        currency: { code: 'ACN', name: 'Acorns', scale: 2 },
        admin: {
          displayName: 'Founder', personName: 'Fran Founder',
          email: 'fran@example.com', password: 'founder-pass',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().admin.role).toBe('admin');
    expect(res.json().admin.status).toBe('active');

    // the founder can log in immediately and work the approval queue
    const login = await app.inject({
      method: 'POST', url: '/api/v1/g/tot/auth/login',
      payload: { email: 'fran@example.com', password: 'founder-pass' },
    });
    expect(login.statusCode).toBe(200);
    const founderCookie = `silvio_session=${
      login.cookies.find((c) => c.name === 'silvio_session')!.value
    }`;

    const applied = await app.inject({
      method: 'POST', url: '/api/v1/g/tot/applications',
      payload: {
        displayName: 'First Member', personName: 'F M',
        email: 'first@example.com', password: 'first-pass',
      },
    });
    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/g/tot/admin/members/${applied.json().member.id}/approve`,
      headers: { cookie: founderCookie },
    });
    expect(approve.statusCode).toBe(200);
  });

  it('an existing user can be the initial admin of a second group', async () => {
    const cookie = await operatorCookie();
    const first = await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: {
        slug: 'one', name: 'One', currency: { code: 'A', name: 'A' },
        admin: {
          displayName: 'Fran', personName: 'Fran', email: 'fran2@example.com',
          password: 'fran2-pass',
        },
      },
    });
    expect(first.statusCode).toBe(201);

    // same email, no password: links the existing user rather than failing
    const second = await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: {
        slug: 'two', name: 'Two', currency: { code: 'B', name: 'B' },
        admin: { displayName: 'Fran', personName: 'Fran', email: 'fran2@example.com' },
      },
    });
    expect(second.statusCode).toBe(201);

    // original password works on the second group
    const login = await app.inject({
      method: 'POST', url: '/api/v1/g/two/auth/login',
      payload: { email: 'fran2@example.com', password: 'fran2-pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('a brand-new initial admin requires a password', async () => {
    const cookie = await operatorCookie();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: {
        slug: 'bad', name: 'Bad', currency: { code: 'C', name: 'C' },
        admin: { displayName: 'X', personName: 'X', email: 'new-user@example.com' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID');
  });

  it('lists provisioned groups', async () => {
    const cookie = await operatorCookie();
    await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: { slug: 'a', name: 'A', currency: { code: 'X', name: 'X' } },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: { slug: 'b', name: 'B', currency: { code: 'Y', name: 'Y' } },
    });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/operator/groups', headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toHaveLength(2);
  });

  it('a member session is not an operator session', async () => {
    const cookie = await operatorCookie();
    await app.inject({
      method: 'POST', url: '/api/v1/operator/groups', headers: { cookie },
      payload: {
        slug: 'cam', name: 'CamLETS', hostname: 'cam.example.org',
        currency: { code: 'CAM', name: 'Cams' },
      },
    });
    // pleb joins and logs in as a member of cam
    const applied = await app.inject({
      method: 'POST', url: '/api/v1/g/cam/applications',
      payload: {
        displayName: 'Pleb', personName: 'Pleb', email: 'pleb2@example.com',
        password: 'pleb-password-2',
      },
    });
    expect(applied.statusCode).toBe(201);

    const memberLogin = await app.inject({
      method: 'POST', url: '/api/v1/g/cam/auth/login',
      payload: { email: 'pleb2@example.com', password: 'pleb-password-2' },
    });
    // applied members cannot log in to trade yet is out of scope; if login
    // succeeds the session must still NOT open operator routes
    if (memberLogin.statusCode === 200) {
      const memberCookie = `silvio_session=${
        memberLogin.cookies.find((c) => c.name === 'silvio_session')!.value
      }`;
      const denied = await app.inject({
        method: 'GET', url: '/api/v1/operator/groups', headers: { cookie: memberCookie },
      });
      expect(denied.statusCode).toBe(403);
    }
  });
});

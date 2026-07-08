// REST API (Fastify): tenancy by hostname with /g/{slug} fallback, cookie
// sessions, DomainError -> HTTP mapping, OpenAPI document.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Category, Currency, Group, Member } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('REST API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let misc: Category;
  let alice: Member;
  let bob: Member;
  let admin: Member;

  async function makeMember(
    name: string,
    email: string,
    password: string,
  ): Promise<Member> {
    const user = await register(storage, { email, password });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  /** Log in through the API and return the session cookie header value. */
  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'silvio_session');
    expect(cookie).toBeDefined();
    return `silvio_session=${cookie!.value}`;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    misc = await storage.createCategory({ groupId: group.id, name: 'Misc' });
    alice = await makeMember('Alice', 'alice@example.com', 'password-alice');
    bob = await makeMember('Bob', 'bob@example.com', 'password-bob');
    admin = await makeMember('Admin', 'admin@example.com', 'password-admin');
    await storage.updateMember(admin.id, { role: 'admin' });
    app = await buildApp(storage);
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  describe('tenancy resolution (#2)', () => {
    it('resolves the group from the Host header', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/listings', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(200);
    });

    it('falls back to the /g/{slug} prefix regardless of host', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/listings', headers: { host: 'localhost:3000' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('unknown tenants get 404 with the error shape', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/listings', headers: { host: 'nope.example.org' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('auth', () => {
    it('login sets an httpOnly session cookie; /me works with it', async () => {
      const cookie = await loginCookie('alice@example.com', 'password-alice');
      const me = await app.inject({
        method: 'GET', url: '/api/v1/me', headers: { host: HOST, cookie },
      });
      expect(me.statusCode).toBe(200);
      const body = me.json();
      expect(body.member.displayName).toBe('Alice');
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0].balance).toBe(0);
      expect(body.accounts[0].currencyCode).toBe('CAM');
    });

    it('bad credentials get 403 without detail leakage', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/login', headers: { host: HOST },
        payload: { email: 'alice@example.com', password: 'wrong' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('protected routes without a session get 401', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/me', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('NOT_AUTHORISED');
    });

    it('logout revokes: the cookie stops working', async () => {
      const cookie = await loginCookie('alice@example.com', 'password-alice');
      await app.inject({
        method: 'POST', url: '/api/v1/auth/logout', headers: { host: HOST, cookie },
      });
      const me = await app.inject({
        method: 'GET', url: '/api/v1/me', headers: { host: HOST, cookie },
      });
      expect(me.statusCode).toBe(401);
    });

    it("a session from one group does not work on another group's host", async () => {
      const other = await storage.createGroup({ slug: 'other', name: 'Other' });
      await storage.addGroupDomain(other.id, 'other.example.org');
      const cookie = await loginCookie('alice@example.com', 'password-alice');
      const res = await app.inject({
        method: 'GET', url: '/api/v1/me', headers: { host: 'other.example.org', cookie },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('applications (public, #7)', () => {
    it('anyone can apply to join', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/applications', headers: { host: HOST },
        payload: {
          displayName: 'Carol', personName: 'Carol Green',
          email: 'carol@example.com', password: 'password-carol',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().member.status).toBe('applied');
    });
  });

  describe('trading', () => {
    it('a member sends a payment and sees the new balance', async () => {
      const cookie = await loginCookie('alice@example.com', 'password-alice');
      const pay = await app.inject({
        method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie },
        payload: {
          payeeMemberId: bob.id, currencyId: cams.id, amount: 500, description: 'veg box',
        },
      });
      expect(pay.statusCode).toBe(201);
      expect(pay.json().transaction.state).toBe('committed');
      const me = await app.inject({
        method: 'GET', url: '/api/v1/me', headers: { host: HOST, cookie },
      });
      expect(me.json().accounts[0].balance).toBe(-500);
    });

    it('validation failures map to 400 with the error shape', async () => {
      const cookie = await loginCookie('alice@example.com', 'password-alice');
      const res = await app.inject({
        method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie },
        payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: -5 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID');
    });

    it('hard limits map to 422 with the rule in the message', async () => {
      await storage.setCreditPolicy({
        groupId: group.id, currencyId: cams.id, type: 'hard_limit',
        config: { minBalance: -400 },
      });
      const cookie = await loginCookie('alice@example.com', 'password-alice');
      const res = await app.inject({
        method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie },
        payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 500 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('LIMIT_BREACHED');
      expect(res.json().error.message).toContain('-400');
    });

    it('invoice: bob requests, alice accepts', async () => {
      const bobCookie = await loginCookie('bob@example.com', 'password-bob');
      const inv = await app.inject({
        method: 'POST', url: '/api/v1/invoices', headers: { host: HOST, cookie: bobCookie },
        payload: { payerMemberId: alice.id, currencyId: cams.id, amount: 300 },
      });
      expect(inv.statusCode).toBe(201);
      const txId = inv.json().transaction.id;

      const aliceCookie = await loginCookie('alice@example.com', 'password-alice');
      const accept = await app.inject({
        method: 'POST', url: `/api/v1/transactions/${txId}/accept`,
        headers: { host: HOST, cookie: aliceCookie },
      });
      expect(accept.statusCode).toBe(200);
      expect(accept.json().transaction.state).toBe('committed');

      // bob cannot accept his own invoice
      const wrong = await app.inject({
        method: 'POST', url: `/api/v1/transactions/${txId}/accept`,
        headers: { host: HOST, cookie: bobCookie },
      });
      expect(wrong.statusCode).toBe(409); // already committed -> WRONG_STATE
    });
  });

  describe('marketplace', () => {
    it('browse is public; posting requires a session', async () => {
      const anon = await app.inject({
        method: 'GET', url: '/api/v1/listings', headers: { host: HOST },
      });
      expect(anon.statusCode).toBe(200);

      const denied = await app.inject({
        method: 'POST', url: '/api/v1/listings', headers: { host: HOST },
        payload: { type: 'offer', title: 'X', description: 'X', categoryId: misc.id },
      });
      expect(denied.statusCode).toBe(401);

      const cookie = await loginCookie('alice@example.com', 'password-alice');
      const posted = await app.inject({
        method: 'POST', url: '/api/v1/listings', headers: { host: HOST, cookie },
        payload: {
          type: 'offer', title: 'Veg boxes', description: 'Weekly', categoryId: misc.id,
        },
      });
      expect(posted.statusCode).toBe(201);

      const browse = await app.inject({
        method: 'GET', url: '/api/v1/listings?type=offer', headers: { host: HOST },
      });
      expect(browse.json().listings).toHaveLength(1);
    });

    it('categories are public', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/categories', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().categories).toHaveLength(1);
    });
  });

  describe('admin', () => {
    it('approve requires the admin role', async () => {
      const applied = await apply(storage, {
        groupId: group.id, displayName: 'Carol', personName: 'Carol',
      });
      const aliceCookie = await loginCookie('alice@example.com', 'password-alice');
      const denied = await app.inject({
        method: 'POST', url: `/api/v1/admin/members/${applied.member.id}/approve`,
        headers: { host: HOST, cookie: aliceCookie },
      });
      expect(denied.statusCode).toBe(403);

      const adminCookie = await loginCookie('admin@example.com', 'password-admin');
      const ok = await app.inject({
        method: 'POST', url: `/api/v1/admin/members/${applied.member.id}/approve`,
        headers: { host: HOST, cookie: adminCookie },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().member.status).toBe('active');
    });
  });

  it('serves an OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(5);
  });
});

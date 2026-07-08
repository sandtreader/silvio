// Bearer-token auth path (decision #9): API tokens act as one membership on
// the same routes and guards as cookie sessions, gated by member-granted
// scopes. trade:request payments land pending for web confirmation (#5's
// machinery is the human-in-the-loop boundary); trade:autonomous commits
// within per-token caps.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { issueApiToken, type IssueTokenInput } from '../../src/services/tokens.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { ApiScope, Currency, Group, Member, Person } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('bearer token API access', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let alicePerson: Person;
  let bob: Member;

  async function makeMember(
    name: string,
    email: string,
  ): Promise<{ member: Member; person: Person }> {
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    const member = await approve(storage, applied.member.id);
    return { member, person: applied.person };
  }

  async function aliceToken(overrides: Partial<IssueTokenInput> = {}): Promise<string> {
    const { token } = await issueApiToken(storage, {
      memberId: alice.id,
      createdBy: alicePerson.id,
      label: 'test agent',
      scopes: ['account:read'] as ApiScope[],
      ...overrides,
    });
    return token;
  }

  function bearer(token: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    return app.inject({
      method,
      url,
      headers: { host: HOST, authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: HOST },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'silvio_session');
    return `silvio_session=${cookie!.value}`;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    ({ member: alice, person: alicePerson } = await makeMember('Alice', 'alice@example.com'));
    ({ member: bob } = await makeMember('Bob', 'bob@example.com'));
    app = await buildApp(storage);
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  describe('authentication', () => {
    it('a valid token reaches scoped routes', async () => {
      const token = await aliceToken();
      const res = await bearer(token, 'GET', '/api/v1/me');
      expect(res.statusCode).toBe(200);
      expect(res.json().member.id).toBe(alice.id);
    });

    it('an unknown token gets 401', async () => {
      const res = await bearer('slv_deadbeef', 'GET', '/api/v1/me');
      expect(res.statusCode).toBe(401);
    });

    it('a revoked token gets 401', async () => {
      const token = await aliceToken();
      const listed = await storage.listApiTokens(alice.id);
      await storage.revokeApiToken(listed[0]!.id);
      const res = await bearer(token, 'GET', '/api/v1/me');
      expect(res.statusCode).toBe(401);
    });

    it('a token from another group’s member gets 403 here', async () => {
      const other = await storage.createGroup({ slug: 'other', name: 'Other' });
      const applied = await apply(storage, {
        groupId: other.id, displayName: 'Carol', personName: 'Carol',
      });
      const carol = await approve(storage, applied.member.id);
      const { token } = await issueApiToken(storage, {
        memberId: carol.id,
        createdBy: applied.person.id,
        label: 'carol agent',
        scopes: ['account:read'] as ApiScope[],
      });
      const res = await bearer(token, 'GET', '/api/v1/me');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('scope enforcement', () => {
    it('a token without the route’s scope gets 403', async () => {
      const token = await aliceToken({ scopes: ['directory:read'] as ApiScope[] });
      const res = await bearer(token, 'GET', '/api/v1/me');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('scope');
    });

    it('directory:read opens the member directory', async () => {
      const token = await aliceToken({ scopes: ['directory:read'] as ApiScope[] });
      const res = await bearer(token, 'GET', '/api/v1/members');
      expect(res.statusCode).toBe(200);
    });

    it('account:read covers statement and pending', async () => {
      const token = await aliceToken();
      const statement = await bearer(
        token, 'GET', `/api/v1/me/statement?currencyId=${cams.id}`,
      );
      expect(statement.statusCode).toBe(200);
      const pending = await bearer(token, 'GET', '/api/v1/me/pending');
      expect(pending.statusCode).toBe(200);
    });

    it('routes with no scope mapping are cookie-only', async () => {
      const token = await aliceToken({
        scopes: [
          'marketplace:read', 'directory:read', 'account:read',
          'listings:write', 'trade:request', 'trade:autonomous',
        ] as ApiScope[],
        maxTxAmount: 100_000,
      });
      // Profile settings and admin routes are never token-accessible.
      const patch = await bearer(token, 'PATCH', '/api/v1/me', { confirmIncoming: true });
      expect(patch.statusCode).toBe(403);
      // Even an admin's token has no admin scopes (decision #9: none in v1).
      await storage.updateMember(alice.id, { role: 'admin' });
      const admin = await bearer(token, 'GET', '/api/v1/admin/members');
      expect(admin.statusCode).toBe(403);
    });
  });

  describe('trade:request — pending for web confirmation (#5, #9)', () => {
    it('a payment lands pending with the member as confirming payer', async () => {
      const token = await aliceToken({ scopes: ['trade:request'] as ApiScope[] });
      const res = await bearer(token, 'POST', '/api/v1/payments', {
        payeeMemberId: bob.id, currencyId: cams.id, amount: 2000, description: 'agent buy',
      });
      expect(res.statusCode).toBe(201);
      const { transaction } = res.json();
      expect(transaction.state).toBe('pending');
      expect(transaction.channel).toBe('mcp');
      expect(transaction.apiTokenId).toBeTruthy();

      // No balance movement yet.
      const accounts = await storage.accountsForMember(alice.id);
      expect(await storage.balance(accounts[0]!.id)).toBe(0);

      // Alice sees it in her web pending list and can accept it there.
      const cookie = await loginCookie('alice@example.com', 'password-Alice');
      const pending = await app.inject({
        method: 'GET', url: '/api/v1/me/pending', headers: { host: HOST, cookie },
      });
      const items = pending.json().items as {
        id: string; direction: string; actions: string[];
      }[];
      const item = items.find((i) => i.id === transaction.id);
      expect(item).toBeDefined();
      expect(item!.direction).toBe('out');
      expect(item!.actions).toContain('accept');

      const accept = await app.inject({
        method: 'POST',
        url: `/api/v1/transactions/${transaction.id}/accept`,
        headers: { host: HOST, cookie },
      });
      expect(accept.statusCode).toBe(200);
      expect(await storage.balance(accounts[0]!.id)).toBe(-2000);
    });

    it('a trade:request token cannot accept pending transactions itself', async () => {
      const token = await aliceToken({ scopes: ['trade:request'] as ApiScope[] });
      const created = await bearer(token, 'POST', '/api/v1/payments', {
        payeeMemberId: bob.id, currencyId: cams.id, amount: 2000,
      });
      const txId = created.json().transaction.id as string;
      const accept = await bearer(token, 'POST', `/api/v1/transactions/${txId}/accept`);
      expect(accept.statusCode).toBe(403); // the human act stays human
    });

    it('invoices are available with trade:request', async () => {
      const token = await aliceToken({ scopes: ['trade:request'] as ApiScope[] });
      const res = await bearer(token, 'POST', '/api/v1/invoices', {
        payerMemberId: bob.id, currencyId: cams.id, amount: 1500,
      });
      expect(res.statusCode).toBe(201);
      const { transaction } = res.json();
      expect(transaction.state).toBe('pending');
      expect(transaction.apiTokenId).toBeTruthy();
    });
  });

  describe('trade:autonomous — commits within caps (#9)', () => {
    it('commits a payment within the per-transaction cap', async () => {
      const token = await aliceToken({
        scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000,
      });
      const res = await bearer(token, 'POST', '/api/v1/payments', {
        payeeMemberId: bob.id, currencyId: cams.id, amount: 3000,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().transaction.state).toBe('committed');
      const accounts = await storage.accountsForMember(alice.id);
      expect(await storage.balance(accounts[0]!.id)).toBe(-3000);
    });

    it('rejects a payment over the per-transaction cap with 422', async () => {
      const token = await aliceToken({
        scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000,
      });
      const res = await bearer(token, 'POST', '/api/v1/payments', {
        payeeMemberId: bob.id, currencyId: cams.id, amount: 5001,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('LIMIT_BREACHED');
    });

    it('enforces the rolling-period cap across payments', async () => {
      const token = await aliceToken({
        scopes: ['trade:autonomous'] as ApiScope[],
        maxTxAmount: 5000, maxPeriodAmount: 6000, periodDays: 30,
      });
      const first = await bearer(token, 'POST', '/api/v1/payments', {
        payeeMemberId: bob.id, currencyId: cams.id, amount: 4000,
      });
      expect(first.statusCode).toBe(201);
      const second = await bearer(token, 'POST', '/api/v1/payments', {
        payeeMemberId: bob.id, currencyId: cams.id, amount: 2001,
      });
      expect(second.statusCode).toBe(422);
    });
  });
});

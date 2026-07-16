// Admin API: member lifecycle actions, credit policies, demurrage bands,
// restrictions, flags, trade reversal — all admin-role gated, audit-relevant.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('admin API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let bob: Member;
  let adminCookie: string;
  let aliceCookie: string;

  async function makeMember(name: string, email: string): Promise<Member> {
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  async function loginCookie(name: string, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { host: HOST },
      payload: { email, password: `password-${name}` },
    });
    const cookie = res.cookies.find((c) => c.name === 'silvio_session');
    return `silvio_session=${cookie!.value}`;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice', 'alice@example.com');
    bob = await makeMember('Bob', 'bob@example.com');
    const admin = await makeMember('Admin', 'admin@example.com');
    await storage.updateMember(admin.id, { role: 'admin' });
    app = await buildApp(storage);
    adminCookie = await loginCookie('Admin', 'admin@example.com');
    aliceCookie = await loginCookie('Alice', 'alice@example.com');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('every admin route rejects non-admin members with 403', async () => {
    const attempts = [
      { method: 'GET' as const, url: '/api/v1/admin/members' },
      { method: 'POST' as const, url: `/api/v1/admin/members/${bob.id}/suspend` },
      { method: 'GET' as const, url: '/api/v1/admin/policies' },
      { method: 'POST' as const, url: '/api/v1/admin/restrictions',
        payload: { memberId: bob.id, reason: 'x' } },
      { method: 'GET' as const, url: `/api/v1/admin/flags?currencyId=${cams.id}` },
    ];
    for (const attempt of attempts) {
      const res = await app.inject({ ...attempt, headers: { host: HOST, cookie: aliceCookie } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lists members by status for the approval queue', async () => {
    await apply(storage, { groupId: group.id, displayName: 'Carol', personName: 'C' });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/members?status=applied',
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(1);
    expect(res.json().members[0].displayName).toBe('Carol');
  });

  it('suspend blocks trading; reinstate restores it', async () => {
    const suspend = await app.inject({
      method: 'POST', url: `/api/v1/admin/members/${bob.id}/suspend`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().member.status).toBe('suspended');

    const denied = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 100 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('SUSPENDED');

    const reinstate = await app.inject({
      method: 'POST', url: `/api/v1/admin/members/${bob.id}/reinstate`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(reinstate.json().member.status).toBe('active');
  });

  it('remove settles the residual to the community and closes the member (#7)', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 250 },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/members/${bob.id}/remove`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.status).toBe('closed');
    const communityAccount = (await storage.listAccounts(group.id, cams.id)).find(
      (a) => a.type === 'community',
    )!;
    expect(await storage.balance(communityAccount.id)).toBe(250);
    expect((await storage.verify(group.id)).ok).toBe(true);
  });

  it('credit policies: create, list (including disabled), disable', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/admin/policies',
      headers: { host: HOST, cookie: adminCookie },
      payload: {
        currencyId: cams.id, type: 'hard_limit', config: { minBalance: -400 },
      },
    });
    expect(created.statusCode).toBe(201);
    const policyId = created.json().policy.id;

    // enforced immediately
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 500 },
    });
    expect(denied.statusCode).toBe(422);

    const disabled = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/policies/${policyId}`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().policy.enabled).toBe(false);

    // no longer enforced, still listed
    const allowed = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 500 },
    });
    expect(allowed.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET', url: '/api/v1/admin/policies', headers: { host: HOST, cookie: adminCookie },
    });
    expect(list.json().policies).toHaveLength(1);
    expect(list.json().policies[0].enabled).toBe(false);
  });

  it('demurrage bands: replace and read back', async () => {
    const put = await app.inject({
      method: 'PUT', url: `/api/v1/admin/demurrage/${cams.id}/bands`,
      headers: { host: HOST, cookie: adminCookie },
      payload: {
        bands: [
          { fromAmount: 0, ratePpmPerMonth: 0 },
          { fromAmount: 10_000, ratePpmPerMonth: 10_000 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET', url: `/api/v1/admin/demurrage/${cams.id}/bands`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(get.json().bands).toHaveLength(2);
    expect(get.json().bands[1].ratePpmPerMonth).toBe(10_000);
  });

  it('restrictions: impose blocks outward payments; lift restores', async () => {
    const imposed = await app.inject({
      method: 'POST', url: '/api/v1/admin/restrictions',
      headers: { host: HOST, cookie: adminCookie },
      payload: { memberId: alice.id, reason: 'persistent taker' },
    });
    expect(imposed.statusCode).toBe(201);

    const denied = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 100 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('RESTRICTED');

    const lifted = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/restrictions/${alice.id}`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(lifted.statusCode).toBe(200);
    const allowed = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 100 },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('flags report soft-threshold crossings (#3)', async () => {
    await storage.setCreditPolicy({
      groupId: group.id, currencyId: cams.id, type: 'soft_threshold',
      config: { thresholds: [{ balance: -200, level: 'notice' }] },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 300 },
    });
    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/flags?currencyId=${cams.id}`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toHaveLength(1);
    expect(res.json().flags[0].memberId).toBe(alice.id);
    expect(res.json().flags[0].level).toBe('notice');
  });

  it('admins can change member roles, but never their own', async () => {
    const promote = await app.inject({
      method: 'POST', url: `/api/v1/admin/members/${bob.id}/role`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { role: 'committee' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().member.role).toBe('committee');

    // non-admin cannot set roles
    const denied = await app.inject({
      method: 'POST', url: `/api/v1/admin/members/${bob.id}/role`,
      headers: { host: HOST, cookie: aliceCookie },
      payload: { role: 'admin' },
    });
    expect(denied.statusCode).toBe(403);

    // self-demotion is blocked — a group must not lose its last admin by accident
    const adminId = (await storage.listMembers(group.id)).find((m) => m.role === 'admin')!.id;
    const self = await app.inject({
      method: 'POST', url: `/api/v1/admin/members/${adminId}/role`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { role: 'member' },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('INVALID');
  });

  it('admins manage categories; the public reads them', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories',
      headers: { host: HOST, cookie: adminCookie },
      payload: { name: 'Gardening' },
    });
    expect(created.statusCode).toBe(201);
    const parentId = created.json().category.id;

    // hierarchy via parentId
    const child = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories',
      headers: { host: HOST, cookie: adminCookie },
      payload: { name: 'Vegetables', parentId },
    });
    expect(child.statusCode).toBe(201);
    expect(child.json().category.parentId).toBe(parentId);

    // rename
    const renamed = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${parentId}`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { name: 'Garden & Outdoors' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().category.name).toBe('Garden & Outdoors');

    // non-admins cannot create
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/admin/categories',
      headers: { host: HOST, cookie: aliceCookie },
      payload: { name: 'Nope' },
    });
    expect(denied.statusCode).toBe(403);

    // publicly readable, rename visible
    const publicList = await app.inject({
      method: 'GET', url: '/api/v1/categories', headers: { host: HOST },
    });
    const names = publicList.json().categories.map((c: { name: string }) => c.name);
    expect(names).toContain('Garden & Outdoors');
    expect(names).toContain('Vegetables');
  });

  it('category edits are tenant-scoped', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const foreign = await storage.createCategory({ groupId: other.id, name: 'Foreign' });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/categories/${foreign.id}`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reverse posts a linked compensating transaction (#5, #6)', async () => {
    const pay = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: aliceCookie },
      payload: { payeeMemberId: bob.id, currencyId: cams.id, amount: 500 },
    });
    const txId = pay.json().transaction.id;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/transactions/${txId}/reverse`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(res.statusCode).toBe(201);
    const reversal = res.json().transaction;
    expect(reversal.type).toBe('reversal');
    expect(reversal.reversesId).toBe(txId);
    expect(reversal.state).toBe('committed');

    const aliceAcc = (await storage.accountsForMember(alice.id))[0]!;
    expect(await storage.balance(aliceAcc.id)).toBe(0);
    expect((await storage.verify(group.id)).ok).toBe(true);

    // a reversal is itself reversible (#25: reversible exactly once, tip-only)
    const again = await app.inject({
      method: 'POST', url: `/api/v1/admin/transactions/${reversal.id}/reverse`,
      headers: { host: HOST, cookie: adminCookie },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().transaction.reversesId).toBe(reversal.id);
  });
});

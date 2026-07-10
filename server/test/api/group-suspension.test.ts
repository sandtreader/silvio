// Group suspension (#20): suspended = read-only. Logins and reads work,
// state changes refuse with GROUP_SUSPENDED, /auth/* stays open, the
// brochure shows a notice, and the operator manages it all.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { bootstrapOperator } from '../../src/services/bootstrap.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { tick } from '../../src/services/scheduler.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

describe('group suspension & operator management (#20)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member; // group admin
  let bob: Member;
  let memberCookie: string;
  let adminCookie: string;
  let operatorCookie: string;

  async function makeMember(name: string): Promise<Member> {
    const email = `${name.toLowerCase()}@example.com`;
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  async function cookieFor(name: string): Promise<string> {
    const { token } = await login(storage, {
      email: `${name.toLowerCase()}@example.com`,
      password: `password-${name}`,
      groupId: group.id,
    });
    return `silvio_session=${token}`;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, 'cam.example.org');
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    bob = await makeMember('Bob');
    await bootstrapOperator(storage, { email: 'op@example.com', password: 'password-op' });
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
    const opLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/operator/login',
      headers: { origin: 'http://localhost' },
      payload: { email: 'op@example.com', password: 'password-op' },
    });
    operatorCookie = (opLogin.headers['set-cookie'] as string).split(';')[0]!;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function operatorPatch(payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/operator/groups/${group.id}`,
      headers: { cookie: operatorCookie, origin: 'http://localhost' },
      payload,
    });
  }

  async function suspend(): Promise<void> {
    const res = await operatorPatch({ status: 'suspended' });
    expect(res.statusCode).toBe(200);
  }

  it('the operator suspends, reinstates and labels a plan; all audited', async () => {
    const res = await operatorPatch({ status: 'suspended', plan: 'hosted-2026' });
    const { group: updated } = res.json() as { group: Group };
    expect(updated.status).toBe('suspended');
    expect(updated.plan).toBe('hosted-2026');

    const back = await operatorPatch({ status: 'active' });
    expect((back.json() as { group: Group }).group.status).toBe('active');

    const { events } = await storage.listAuditEvents(group.id, { action: 'group.status' });
    expect(events).toHaveLength(2);
  });

  it('non-operators may not touch operator group management', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/operator/groups/${group.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('suspended: state changes refuse, reads and logins keep working', async () => {
    await suspend();

    // Trading refuses with the dedicated code.
    const pay = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/payments',
      headers: { cookie: memberCookie, origin: 'http://localhost' },
      payload: { payeeMemberId: alice.id, currencyId: cams.id, amount: 100 },
    });
    expect(pay.statusCode).toBe(403);
    expect((pay.json() as { error: { code: string } }).error.code).toBe('GROUP_SUSPENDED');

    // Admin writes refuse too.
    const page = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/admin/pages',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { slug: 'x', title: 'X', body: 'x', visibility: 'public' },
    });
    expect(page.statusCode).toBe(403);

    // Applications (new members) refuse.
    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/applications',
      headers: { origin: 'http://localhost' },
      payload: {
        displayName: 'Carol', personName: 'Carol',
        email: 'carol@example.com', password: 'password-carol',
      },
    });
    expect(applied.statusCode).toBe(403);

    // Reads still work: /me, statements, listings.
    expect((await app.inject({
      method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie: memberCookie },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/api/v1/g/cam/listings', headers: { cookie: memberCookie },
    })).statusCode).toBe(200);

    // Logins (auth is user-level) still work.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/login',
      headers: { origin: 'http://localhost' },
      payload: { email: 'bob@example.com', password: 'password-Bob' },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('the brochure shows the notice and hides the market; /shell carries the flag', async () => {
    await suspend();
    const home = await app.inject({
      method: 'GET', url: '/', headers: { host: 'cam.example.org' },
    });
    expect(home.statusCode).toBe(200);
    expect(home.body.toLowerCase()).toContain('suspended');

    const category = await storage.createCategory({ groupId: group.id, name: 'Food' });
    await storage.updateGroup(group.id, { status: 'active' });
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly',
    });
    await storage.updateGroup(group.id, { status: 'suspended' });
    const market = await app.inject({
      method: 'GET', url: '/market', headers: { host: 'cam.example.org' },
    });
    expect(market.body.toLowerCase()).toContain('suspended');
    expect(market.body).not.toContain('Veg box');

    const shell = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/shell',
    });
    expect((shell.json() as { suspended?: boolean }).suspended).toBe(true);
  });

  it('the scheduler skips a suspended group but still verifies it', async () => {
    // A held payment that would auto-accept, and a listing that would warn.
    const persons = await storage.personsForMember(alice.id);
    await storage.updateMember(bob.id, { confirmIncoming: true });
    const { sendPayment } = await import('../../src/services/trading.js');
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 100, actorPersonId: persons[0]!.id, channel: 'web',
      expiresAt: '2000-01-01T00:00:00.000Z', // long overdue
    });
    await suspend();
    const report = await tick(storage, new Date().toISOString(), { alert: () => {} });
    expect(report.autoAccepted).toBe(0);
    expect(report.expired).toBe(0);
    expect(report.digestsSent).toBe(0);
    expect(report.verifyFailures).toBe(0); // verified, and clean
  });

  it('the operator adds and removes domains', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/operator/groups/${group.id}/domains`,
      headers: { cookie: operatorCookie, origin: 'http://localhost' },
      payload: { hostname: 'camlets.org.uk' },
    });
    expect(add.statusCode).toBe(201);
    expect(await storage.groupByDomain('camlets.org.uk')).toMatchObject({ id: group.id });

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/operator/groups/${group.id}/domains/camlets.org.uk`,
      headers: { cookie: operatorCookie, origin: 'http://localhost' },
    });
    expect(remove.statusCode).toBe(200);
    expect(await storage.groupByDomain('camlets.org.uk')).toBeUndefined();
  });
});

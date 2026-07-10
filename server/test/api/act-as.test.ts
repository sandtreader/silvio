// Admin acts-for-member (#24): an acting context on the admin's own
// session — the app presents as the member, attribution stays the admin,
// escalation paths are shut, and everything is audited.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member, Transaction } from '../../src/types.js';

describe('admin acts-for-member (#24)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member; // admin
  let bob: Member; // the offline member
  let carol: Member;
  let adminCookie: string;
  let memberCookie: string;

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
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    bob = await makeMember('Bob');
    carol = await makeMember('Carol');
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Carol');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function actAs(memberId: string, cookie = adminCookie) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/g/cam/admin/members/${memberId}/act-as`,
      headers: { cookie, origin: 'http://localhost' },
    });
  }

  function me(cookie = adminCookie) {
    return app.inject({
      method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie },
    });
  }

  it('acting presents the member with an acting flag; stop restores the admin', async () => {
    expect((await actAs(bob.id)).statusCode).toBe(200);

    const acting = (await me()).json() as {
      member: { id: string }; acting?: { forMemberId: string };
    };
    expect(acting.member.id).toBe(bob.id);
    expect(acting.acting).toMatchObject({ forMemberId: bob.id });

    const shell = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/shell', headers: { cookie: adminCookie },
    });
    expect((shell.json() as { member?: { acting?: boolean } }).member?.acting).toBe(true);

    const stop = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/stop-acting',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(stop.statusCode).toBe(200);
    const restored = (await me()).json() as { member: { id: string }; acting?: unknown };
    expect(restored.member.id).toBe(alice.id);
    expect(restored.acting).toBeUndefined();
  });

  it('payments made while acting carry the admin as creator', async () => {
    await actAs(bob.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/payments',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: {
        payeeMemberId: carol.id, currencyId: cams.id, amount: 100,
        description: 'paper trading sheet',
      },
    });
    expect(res.statusCode).toBe(201);
    const { transaction } = res.json() as { transaction: Transaction };
    // Bob pays Carol...
    const negative = transaction.entries.find((e) => e.amount < 0)!;
    const account = await storage.getAccount(negative.accountId);
    expect(account.memberId).toBe(bob.id);
    // ...but the journal records the admin as the actor — attribution
    // never lies (#24). Alice's user id, not any of Bob's persons.
    const aliceUser = await storage.credentialsForEmail('alice@example.com');
    expect(transaction.createdBy).toBe(aliceUser!.user.id);
  });

  it('impersonation cannot escalate: tokens, persons and admin routes refuse', async () => {
    await actAs(bob.id);
    expect((await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/tokens',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { label: 'sneaky', scopes: ['account:read'] },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/persons',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { name: 'Mole', email: 'mole@example.com' },
    })).statusCode).toBe(403);
    // The session presents as Bob (role member): the admin area is shut.
    expect((await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/members', headers: { cookie: adminCookie },
    })).statusCode).toBe(403);
  });

  it('acting is admin-only, group-confined, and audited both ways', async () => {
    expect((await actAs(bob.id, memberCookie)).statusCode).toBe(403);

    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const stranger = await storage.createMember({
      groupId: other.id, displayName: 'Stranger',
    });
    expect((await actAs(stranger.id)).statusCode).toBe(404);

    await actAs(bob.id);
    await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/stop-acting',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    const started = await storage.listAuditEvents(group.id, { action: 'member.act_as' });
    expect(started.total).toBe(1);
    expect(started.events[0]!.actingForMemberId).toBe(bob.id);
    expect((await storage.listAuditEvents(group.id, { action: 'member.stop_acting' })).total)
      .toBe(1);
  });
});

// Admin transaction list/search (todo: API polish) — finding a transaction
// to reverse currently needs a pasted id; this gives admins a filtered,
// paginated list at GET /admin/transactions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member, Transaction } from '../../src/types.js';

describe('GET /admin/transactions', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member; // admin
  let bob: Member;
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
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 500, description: 'veg box', actorPersonId: 'p', channel: 'web',
    });
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: bob.id, payeeMemberId: alice.id,
      currencyId: cams.id, amount: 200, description: 'bike repair', actorPersonId: 'p', channel: 'web',
    });
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('lists transactions with a total', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transactions: Transaction[]; total: number };
    expect(body.total).toBe(2);
    expect(body.transactions).toHaveLength(2);
    // Full transaction shape, entries included, so an admin can pick one to reverse.
    for (const tx of body.transactions) {
      expect(tx.id).toBeTruthy();
      expect(tx.entries).toHaveLength(2);
      expect(tx.state).toBe('committed');
    }
  });

  it('text search narrows the list', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?q=veg',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transactions: Transaction[]; total: number };
    expect(body.total).toBe(1);
    expect(body.transactions[0]!.description).toBe('veg box');
  });

  it('filters by member and paginates', async () => {
    const byMember = await app.inject({
      method: 'GET', url: `/api/v1/g/cam/admin/transactions?memberId=${bob.id}`,
      headers: { cookie: adminCookie },
    });
    expect((byMember.json() as { total: number }).total).toBe(2);

    const page = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?limit=1&offset=1',
      headers: { cookie: adminCookie },
    });
    const body = page.json() as { transactions: Transaction[]; total: number };
    expect(body.total).toBe(2);
    expect(body.transactions).toHaveLength(1);
  });

  it('requires the admin role', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions',
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

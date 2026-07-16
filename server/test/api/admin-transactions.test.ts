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

  // Entries name their account's owner so the UI can derive source ->
  // destination without an extra lookup; system-side accounts carry the
  // account type instead of a member.
  it('enriches entries with account type, currency and member identity', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?q=veg',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    type EnrichedEntry = {
      amount: number;
      accountType: string;
      currencyId: string;
      memberId?: string;
      memberNo?: number;
      displayName?: string;
    };
    const [tx] = (res.json() as { transactions: { entries: EnrichedEntry[] }[] })
      .transactions;
    const payer = tx!.entries.find((e) => e.amount < 0);
    const payee = tx!.entries.find((e) => e.amount > 0);
    expect(payer).toMatchObject({
      accountType: 'member',
      currencyId: cams.id,
      memberId: alice.id,
      memberNo: alice.memberNo,
      displayName: 'Alice',
    });
    expect(payee).toMatchObject({
      accountType: 'member',
      currencyId: cams.id,
      memberId: bob.id,
      memberNo: bob.memberNo,
      displayName: 'Bob',
    });
  });

  // Reversal semantics (#25): any committed transaction is reversible exactly
  // once — including reversals themselves, so a mistaken reversal is undone by
  // reversing it (and reapplied by reversing THAT). Only the chain tip is
  // ever reversible; nothing becomes re-reversible.
  it('reverses only once; the reversal itself is reversible, tip-only', async () => {
    async function reverseOf(id: string) {
      return app.inject({
        method: 'POST', url: `/api/v1/g/cam/admin/transactions/${id}/reverse`,
        headers: { cookie: adminCookie },
      });
    }
    const list = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?q=veg',
      headers: { cookie: adminCookie },
    });
    const veg = (list.json() as { transactions: Transaction[] }).transactions[0]!;

    const first = await reverseOf(veg.id);
    expect(first.statusCode).toBe(201);
    const r1 = (first.json() as { transaction: Transaction }).transaction;

    expect((await reverseOf(veg.id)).statusCode).toBe(409); // already reversed

    const second = await reverseOf(r1.id); // undoing the reversal is allowed
    expect(second.statusCode).toBe(201);

    expect((await reverseOf(r1.id)).statusCode).toBe(409); // r1 now reversed too
    expect((await reverseOf(veg.id)).statusCode).toBe(409); // original stays done

    expect((await storage.verify(group.id)).ok).toBe(true);
  });

  it('reversal descriptions carry seq, from -> to and the description (#25)', async () => {
    const list = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?q=veg',
      headers: { cookie: adminCookie },
    });
    const veg = (list.json() as { transactions: Transaction[] }).transactions[0]!;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/g/cam/admin/transactions/${veg.id}/reverse`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(201);
    const r1 = (res.json() as { transaction: Transaction }).transaction;
    expect(r1.description).toBe(`Reversal of #${veg.seq}: Alice → Bob, veg box`);

    // Reversing the reversal names the reversal (its own legs run Bob → Alice).
    const res2 = await app.inject({
      method: 'POST', url: `/api/v1/g/cam/admin/transactions/${r1.id}/reverse`,
      headers: { cookie: adminCookie },
    });
    const r2 = (res2.json() as { transaction: Transaction }).transaction;
    expect(r2.description).toMatch(new RegExp(`^Reversal of #${r1.seq}: Bob → Alice, `));
  });

  it('elides a long original description in the reversal', async () => {
    const long = 'hedge trimming and general garden tidy-up including the back passage';
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 300, description: long,
      actorPersonId: 'p', channel: 'web',
    });
    const list = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?q=tidy-up',
      headers: { cookie: adminCookie },
    });
    const tx = (list.json() as { transactions: Transaction[] }).transactions[0]!;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/g/cam/admin/transactions/${tx.id}/reverse`,
      headers: { cookie: adminCookie },
    });
    const description = (res.json() as { transaction: Transaction }).transaction
      .description!;
    expect(description).toContain('hedge trimming');
    expect(description).not.toContain(long);
    expect(description.endsWith('…')).toBe(true);
  });

  it('marks reversed transactions with reversedById in the listing (#25)', async () => {
    const before = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions?q=veg',
      headers: { cookie: adminCookie },
    });
    const veg = (before.json() as { transactions: Transaction[] }).transactions[0]!;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/g/cam/admin/transactions/${veg.id}/reverse`,
      headers: { cookie: adminCookie },
    });
    const r1 = (res.json() as { transaction: Transaction }).transaction;

    const after = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/transactions',
      headers: { cookie: adminCookie },
    });
    type Listed = Transaction & { reversedById?: string };
    const listed = (after.json() as { transactions: Listed[] }).transactions;
    expect(listed.find((t) => t.id === veg.id)?.reversedById).toBe(r1.id);
    const bike = listed.find((t) => t.description === 'bike repair');
    expect(bike).toBeDefined();
    expect(bike).not.toHaveProperty('reversedById');
  });

  // The shared Entry schema stays name-free: a member-facing route returning
  // a Transaction must not gain the enrichment (response schemas are the
  // leak guard).
  it('does not leak enrichment through member-facing transaction routes', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/g/cam/payments',
      headers: { cookie: memberCookie },
      payload: { payeeMemberId: alice.id, currencyId: cams.id, amount: 100 },
    });
    expect(res.statusCode).toBe(201);
    const { transaction } = res.json() as { transaction: { entries: object[] } };
    expect(transaction.entries.length).toBeGreaterThan(0);
    for (const entry of transaction.entries) {
      expect(entry).not.toHaveProperty('displayName');
      expect(entry).not.toHaveProperty('memberId');
      expect(entry).not.toHaveProperty('accountType');
    }
  });
});

// Admin dashboard stats (plan.md: "Dashboard statistics/graphs of balance
// distribution, currency flow over time"; todo adds velocity and
// dormancy). One endpoint per currency; the UI draws the graphs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

interface StatsBody {
  balances: { memberId: string; displayName: string; balance: number }[];
  flow: { month: string; volume: number; trades: number }[];
  velocity: number;
  dormant: { memberId: string; displayName: string; lastTradeAt?: string }[];
}

describe('admin stats API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let bob: Member;
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
    carol = await makeMember('Carol'); // never trades: dormant
    const persons = await storage.personsForMember(alice.id);
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 500, actorPersonId: persons[0]!.id, channel: 'web',
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

  function stats(cookie = adminCookie) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/admin/stats?currencyId=${cams.id}`,
      headers: { cookie },
    });
  }

  it('returns named balances, monthly flow, velocity and dormancy', async () => {
    const res = await stats();
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsBody;

    const byName = new Map(body.balances.map((b) => [b.displayName, b.balance]));
    expect(byName.get('Alice')).toBe(-500);
    expect(byName.get('Bob')).toBe(500);

    const thisMonth = new Date().toISOString().slice(0, 7);
    const current = body.flow.find((bucket) => bucket.month === thisMonth);
    expect(current).toMatchObject({ volume: 500, trades: 1 });

    // 500 traded in the window over 500 total positive balance.
    expect(body.velocity).toBeCloseTo(1, 5);

    // Carol has never traded; Alice and Bob traded just now.
    expect(body.dormant.map((d) => d.displayName)).toEqual(['Carol']);
    expect(body.dormant[0]!.lastTradeAt).toBeUndefined();
  });

  it('is admin-only and requires a currency', async () => {
    expect((await stats(memberCookie)).statusCode).toBe(403);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/stats', headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

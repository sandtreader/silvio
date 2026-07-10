// Group balances view (#19): when the group turns transparency on, members
// see everyone's balance and 12-month turnover. Off means 404 — a feature
// that does not exist, not one that is forbidden.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

interface BalancesBody {
  balances: {
    memberId: string;
    displayName: string;
    balance: number;
    turnover: number;
  }[];
}

describe('group balances view (#19)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let memberCookie: string;

  async function makeMember(name: string): Promise<Member> {
    const email = `${name.toLowerCase()}@example.com`;
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const alice = await makeMember('Alice');
    const bob = await makeMember('Bob');
    const persons = await storage.personsForMember(alice.id);
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 700, actorPersonId: persons[0]!.id, channel: 'web',
    });
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'bob@example.com', password: 'password-Bob', groupId: group.id,
    });
    memberCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function balances(cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers['cookie'] = cookie;
    return app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/balances?currencyId=${cams.id}`,
      headers,
    });
  }

  it('is a 404 until the group opts in', async () => {
    expect((await balances(memberCookie)).statusCode).toBe(404);
  });

  it('members see names, balances and turnover once enabled', async () => {
    await storage.updateGroup(group.id, { settings: { transparency: 'balances' } });
    const res = await balances(memberCookie);
    expect(res.statusCode).toBe(200);
    const { balances: rows } = res.json() as BalancesBody;
    const bob = rows.find((r) => r.displayName === 'Bob');
    const alice = rows.find((r) => r.displayName === 'Alice');
    expect(bob).toMatchObject({ balance: 700, turnover: 700 });
    expect(alice).toMatchObject({ balance: -700, turnover: 0 });
  });

  it('needs a member session even when enabled', async () => {
    await storage.updateGroup(group.id, { settings: { transparency: 'balances' } });
    expect((await balances()).statusCode).toBe(401);
  });
});

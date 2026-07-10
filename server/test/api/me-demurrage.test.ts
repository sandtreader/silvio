// Demurrage projection (#1): /me accounts carry "if unspent, ~X on the
// 1st" — the charge the current balance would attract at the next posting,
// computed with the same marginal-band engine the real run uses.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

interface MeAccount {
  currencyId: string;
  balance: number;
  demurrage?: { amount: number; postingDate: string };
}

describe('demurrage projection on /me (#1)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let bob: Member;

  async function makeMember(name: string): Promise<Member> {
    const email = `${name.toLowerCase()}@example.com`;
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  async function accountsFor(name: string): Promise<MeAccount[]> {
    const { token } = await login(storage, {
      email: `${name.toLowerCase()}@example.com`,
      password: `password-${name}`,
      groupId: group.id,
    });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie: `silvio_session=${token}` },
    });
    return (res.json() as { accounts: MeAccount[] }).accounts;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    // Posting on the 1st, free base to 100.00, then 1%/month marginal.
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2, demurrageDay: 1,
    });
    await storage.setDemurrageBands(cams.id, [
      { fromAmount: 0, ratePpmPerMonth: 0 },
      { fromAmount: 10_000, ratePpmPerMonth: 10_000 },
    ]);
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    bob = await makeMember('Bob');
    const persons = await storage.personsForMember(alice.id);
    // Bob ends at +500.00, Alice at -500.00.
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 50_000, actorPersonId: persons[0]!.id, channel: 'web',
    });
    app = await buildApp(storage);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('a positive balance projects the next posting’s charge and date', async () => {
    const [account] = await accountsFor('Bob');
    // (50000 - 10000) * 1% = 400 minor units.
    expect(account!.demurrage).toBeDefined();
    expect(account!.demurrage!.amount).toBe(400);
    // The next 1st of a month, as a date.
    const posting = account!.demurrage!.postingDate;
    expect(posting).toMatch(/^\d{4}-\d{2}-01$/);
    expect(posting > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('negative balances and demurrage-free currencies project nothing', async () => {
    const [account] = await accountsFor('Alice');
    expect(account!.balance).toBe(-50_000);
    expect(account!.demurrage).toBeUndefined();
  });
});

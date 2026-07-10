// Statement pagination + CSV export (todo: Payments & ledger). The JSON
// statement pages newest-first with a total; the CSV download is the whole
// history, oldest first, amounts at the currency's real scale.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member, StatementLine } from '../../src/types.js';

describe('statement paging & CSV', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let bob: Member;
  let bobCookie: string;

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
    alice = await makeMember('Alice');
    bob = await makeMember('Bob');
    const persons = await storage.personsForMember(alice.id);
    // Three payments to Bob: 1.00, 2.00, 3.00 — Bob ends at 6.00.
    for (const amount of [100, 200, 300]) {
      await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount, actorPersonId: persons[0]!.id, channel: 'web',
        ...(amount === 200 ? { description: 'veg, "the good stuff"' } : {}),
      });
    }
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'bob@example.com', password: 'password-Bob', groupId: group.id,
    });
    bobCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('pages newest first with a total', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/me/statement?currencyId=${cams.id}&limit=2`,
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
    const { lines, total } = res.json() as { lines: StatementLine[]; total: number };
    expect(total).toBe(3);
    expect(lines.map((l) => l.amount)).toEqual([300, 200]);
    expect(lines.map((l) => l.runningBalance)).toEqual([600, 300]);

    const rest = await app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/me/statement?currencyId=${cams.id}&limit=2&offset=2`,
      headers: { cookie: bobCookie },
    });
    expect((rest.json() as { lines: StatementLine[] }).lines.map((l) => l.amount))
      .toEqual([100]);
  });

  it('downloads the whole statement as CSV, oldest first, scaled amounts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/me/statement.csv?currencyId=${cams.id}`,
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('statement-CAM.csv');

    const rows = res.body.trim().split('\n');
    expect(rows[0]).toBe('Date,Type,Description,Reference,Amount,Balance');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain(',1.00,1.00');
    // Embedded comma and quotes survive CSV quoting.
    expect(rows[2]).toContain('"veg, ""the good stuff"""');
    expect(rows[3]).toContain(',3.00,6.00');
  });

  it('the CSV needs a session too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/me/statement.csv?currencyId=${cams.id}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

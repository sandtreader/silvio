// Signed QR payment requests (#22): the payee mints a server-signed
// payload, the payer's app decodes it for a trustworthy confirm screen,
// and the scan endpoint pays idempotently.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member, Transaction } from '../../src/types.js';

describe('signed QR payment requests (#22)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member; // payee
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;

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
    // Alice confirms incoming normally — a scan must NOT be held (#22).
    await storage.updateMember(alice.id, { confirmIncoming: true });
    await makeMember('Bob');
    await makeMember('Carol');
    app = await buildApp(storage);
    await app.ready();
    aliceCookie = await cookieFor('Alice');
    bobCookie = await cookieFor('Bob');
    carolCookie = await cookieFor('Carol');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  async function mint(body: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/payment-requests',
      headers: { cookie: aliceCookie, origin: 'http://localhost' },
      payload: { currencyId: cams.id, ...body },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { payload: string }).payload;
  }

  function decode(payload: string, cookie = bobCookie) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/payment-requests/decode?payload=${encodeURIComponent(payload)}`,
      headers: { cookie },
    });
  }

  function scan(payload: string, cookie = bobCookie, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/payments/scan',
      headers: { cookie, origin: 'http://localhost' },
      payload: { payload, ...extra },
    });
  }

  it('mints, decodes to verified details, and pays committed', async () => {
    const payload = await mint({ amount: 500, reference: 'veg box' });

    const decoded = await decode(payload);
    expect(decoded.statusCode).toBe(200);
    expect(decoded.json()).toMatchObject({
      payeeName: 'Alice', amount: 500, reference: 'veg box', currencyId: cams.id,
    });

    const paid = await scan(payload);
    expect(paid.statusCode).toBe(201);
    const { transaction } = paid.json() as { transaction: Transaction };
    // Committed despite Alice's confirm-incoming: she minted the request.
    expect(transaction.state).toBe('committed');
    expect(transaction.description).toBe('veg box');
  });

  it('a double scan is one payment; another member paying is a second', async () => {
    const payload = await mint({ amount: 300 });
    const first = (await scan(payload)).json() as { transaction: Transaction };
    const again = (await scan(payload)).json() as { transaction: Transaction };
    expect(again.transaction.id).toBe(first.transaction.id);

    const carol = (await scan(payload, carolCookie)).json() as { transaction: Transaction };
    expect(carol.transaction.id).not.toBe(first.transaction.id);
  });

  it('an open-amount request takes the payer’s amount; a fixed one must match', async () => {
    const open = await mint({});
    expect((await scan(open)).statusCode).toBe(400); // amount required
    const paid = await scan(open, bobCookie, { amount: 250 });
    expect(paid.statusCode).toBe(201);
    expect((paid.json() as { transaction: Transaction }).transaction.entries
      .find((e) => e.amount > 0)!.amount).toBe(250);

    const fixed = await mint({ amount: 500 });
    expect((await scan(fixed, carolCookie, { amount: 400 })).statusCode).toBe(400);
  });

  it('tampering breaks the signature; expiry and self-payment are refused', async () => {
    const payload = await mint({ amount: 500 });
    const [body, sig] = payload.split('.');
    const json = JSON.parse(Buffer.from(body!, 'base64url').toString());
    json.amount = 1;
    const forged = `${Buffer.from(JSON.stringify(json)).toString('base64url')}.${sig}`;
    expect((await decode(forged)).statusCode).toBe(400);
    expect((await scan(forged)).statusCode).toBe(400);
    expect((await scan('garbage')).statusCode).toBe(400);

    const expired = await mint({ amount: 500, expiresAt: '2000-01-01T00:00:00.000Z' });
    expect((await scan(expired)).statusCode).toBe(400);

    // Alice scanning her own QR makes no sense.
    expect((await scan(payload, aliceCookie)).statusCode).toBe(400);
  });

  it('a payload from another group is rejected there', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other LETS' });
    const otherCur = await storage.createCurrency({
      groupId: other.id, code: 'OTH', name: 'Others', scale: 2,
    });
    await storage.createAccount({
      groupId: other.id, currencyId: otherCur.id, type: 'community',
    });
    const payload = await mint({ amount: 500 });
    const user = await register(storage, {
      email: 'dave@example.com', password: 'password-Dave',
    });
    const applied = await apply(storage, {
      groupId: other.id, displayName: 'Dave', personName: 'Dave',
      email: 'dave@example.com', userId: user.id,
    });
    await approve(storage, applied.member.id);
    const { token } = await login(storage, {
      email: 'dave@example.com', password: 'password-Dave', groupId: other.id,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/other/payments/scan',
      headers: { cookie: `silvio_session=${token}`, origin: 'http://localhost' },
      payload: { payload },
    });
    expect(res.statusCode).toBe(400);
  });
});

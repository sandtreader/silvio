// Member self-service and directory: statement, pending items, settings,
// members list with trade stats (decision #8's substitute for ratings).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('member API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let bob: Member;

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

  async function pay(cookie: string, payeeId: string, amount: number): Promise<void> {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie },
      payload: { payeeMemberId: payeeId, currencyId: cams.id, amount },
    });
    expect(res.statusCode).toBe(201);
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice', 'alice@example.com');
    bob = await makeMember('Bob', 'bob@example.com');
    app = await buildApp(storage);
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('PATCH /me updates confirm-incoming and display name', async () => {
    const cookie = await loginCookie('Alice', 'alice@example.com');
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/me', headers: { host: HOST, cookie },
      payload: { confirmIncoming: true, displayName: 'Alice S' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member.confirmIncoming).toBe(true);
    expect(res.json().member.displayName).toBe('Alice S');
  });

  it('GET /me/statement returns lines with running balance', async () => {
    const aliceCookie = await loginCookie('Alice', 'alice@example.com');
    const bobCookie = await loginCookie('Bob', 'bob@example.com');
    await pay(aliceCookie, bob.id, 500);
    await pay(bobCookie, alice.id, 200);

    const res = await app.inject({
      method: 'GET', url: `/api/v1/me/statement?currencyId=${cams.id}`,
      headers: { host: HOST, cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.json().lines;
    expect(lines).toHaveLength(2);
    expect(lines.map((l: { amount: number }) => l.amount)).toEqual([-500, 200]);
    expect(lines.at(-1).runningBalance).toBe(-300);
  });

  it('GET /me/pending lists invoices to pay and payments to confirm', async () => {
    await storage.updateMember(alice.id, { confirmIncoming: true });
    const aliceCookie = await loginCookie('Alice', 'alice@example.com');
    const bobCookie = await loginCookie('Bob', 'bob@example.com');
    // bob invoices alice (alice must accept) and bob pays alice (alice must confirm)
    await app.inject({
      method: 'POST', url: '/api/v1/invoices', headers: { host: HOST, cookie: bobCookie },
      payload: { payerMemberId: alice.id, currencyId: cams.id, amount: 300 },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/payments', headers: { host: HOST, cookie: bobCookie },
      payload: { payeeMemberId: alice.id, currencyId: cams.id, amount: 100 },
    });

    const res = await app.inject({
      method: 'GET', url: '/api/v1/me/pending', headers: { host: HOST, cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    const pending = res.json().pending;
    expect(pending).toHaveLength(2);
    const flows = pending.map((p: { flow: string }) => p.flow).sort();
    expect(flows).toEqual(['invoice', 'payment']);
    // each item says what the member can do
    for (const item of pending) {
      expect(['accept', 'decline']).toContain(item.actions[0]);
    }
  });

  it('GET /members lists active members for members only', async () => {
    const anon = await app.inject({
      method: 'GET', url: '/api/v1/members', headers: { host: HOST },
    });
    expect(anon.statusCode).toBe(401);

    const cookie = await loginCookie('Alice', 'alice@example.com');
    const res = await app.inject({
      method: 'GET', url: '/api/v1/members', headers: { host: HOST, cookie },
    });
    expect(res.statusCode).toBe(200);
    const members = res.json().members;
    expect(members).toHaveLength(2);
    expect(members[0]).toHaveProperty('memberNo');
    expect(members[0]).toHaveProperty('displayName');
    expect(members[0]).not.toHaveProperty('confirmIncoming'); // private settings not exposed
  });

  it('GET /members/:id shows profile with journal-derived trade stats (#8)', async () => {
    const aliceCookie = await loginCookie('Alice', 'alice@example.com');
    await pay(aliceCookie, bob.id, 500);

    const res = await app.inject({
      method: 'GET', url: `/api/v1/members/${bob.id}`,
      headers: { host: HOST, cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.member.displayName).toBe('Bob');
    expect(body.stats.trades).toBe(1);
    expect(body.stats.partners).toBe(1);
    expect(body.stats.lastTradeAt).toBeDefined();
  });

  it('members of another group are invisible', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const stranger = await storage.createMember({ groupId: other.id, displayName: 'Stranger' });
    const cookie = await loginCookie('Alice', 'alice@example.com');
    const res = await app.inject({
      method: 'GET', url: `/api/v1/members/${stranger.id}`,
      headers: { host: HOST, cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

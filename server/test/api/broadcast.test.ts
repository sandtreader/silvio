// Admin broadcast (#17) and the member digest preference: a broadcast
// queues one markdown email per person on every active membership; members
// set their own digestFrequency through PATCH /me.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { EmailEvent, Group, Member } from '../../src/types.js';

describe('admin broadcast & digest preference (#17)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let adminCookie: string;
  let memberCookie: string;

  async function makeMember(name: string, approveIt = true): Promise<Member> {
    const email = `${name.toLowerCase()}@example.com`;
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approveIt ? approve(storage, applied.member.id) : applied.member;
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
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    await makeMember('Bob');
    await makeMember('Carol', false); // applied, never approved — no broadcasts
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function broadcast(payload: Record<string, unknown>, cookie = adminCookie) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/admin/broadcast',
      headers: { cookie, origin: 'http://localhost' },
      payload,
    });
  }

  async function broadcasts(): Promise<EmailEvent[]> {
    return (await storage.pendingEmails(100)).filter((e) => e.kind === 'broadcast');
  }

  it('queues one email per person on every active membership', async () => {
    const res = await broadcast({
      subject: 'AGM on Thursday', body: 'Come to the **AGM**.',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { queued: number }).queued).toBe(2); // Alice + Bob, not Carol

    const events = await broadcasts();
    expect(events.map((e) => e.toEmail).sort())
      .toEqual(['alice@example.com', 'bob@example.com']);
    expect(events[0]!.subject).toBe('AGM on Thursday');
    expect(events[0]!.body).toBe('Come to the **AGM**.'); // markdown source, as sent
  });

  it('a second broadcast is not deduped away', async () => {
    await broadcast({ subject: 'One', body: 'x' });
    await broadcast({ subject: 'Two', body: 'y' });
    expect(await broadcasts()).toHaveLength(4);
  });

  it('is admin-only and requires subject and body', async () => {
    expect((await broadcast({ subject: 's', body: 'b' }, memberCookie)).statusCode).toBe(403);
    expect((await broadcast({ subject: 's' })).statusCode).toBe(400);
  });

  describe('digest preference (PATCH /me)', () => {
    it('members set their own frequency; /me reflects it', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/g/cam/me',
        headers: { cookie: memberCookie, origin: 'http://localhost' },
        payload: { digestFrequency: 'monthly' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { member: Member }).member.digestFrequency).toBe('monthly');

      const me = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie: memberCookie },
      });
      expect((me.json() as { member: Member }).member.digestFrequency).toBe('monthly');
    });

    it('rejects a frequency outside none|weekly|monthly', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/g/cam/me',
        headers: { cookie: memberCookie, origin: 'http://localhost' },
        payload: { digestFrequency: 'hourly' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

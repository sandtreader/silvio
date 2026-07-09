// Restriction impose/lift routes enqueue restriction emails (todo: Email &
// notifications). The routes call storage directly, so the notification
// wiring lives in the route handlers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

describe('restriction routes enqueue emails', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let alice: Member; // admin
  let bob: Member;
  let adminCookie: string;

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
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    bob = await makeMember('Bob');
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'password-Alice', groupId: group.id,
    });
    adminCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  async function kinds(): Promise<string[]> {
    return (await storage.pendingEmails(100)).map((e) => e.kind);
  }

  it('imposing a restriction enqueues restriction_imposed to the member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/admin/restrictions',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { memberId: bob.id, reason: 'runaway balance' },
    });
    expect(res.statusCode).toBe(201);
    const events = (await storage.pendingEmails(100)).filter(
      (e) => e.kind === 'restriction_imposed',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.toEmail).toBe('bob@example.com');
  });

  it('lifting a restriction enqueues restriction_lifted to the member', async () => {
    await storage.imposeRestriction(bob.id, 'runaway balance', alice.id);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/restrictions/${bob.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect(await kinds()).toContain('restriction_lifted');
  });
});

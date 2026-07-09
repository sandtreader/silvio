// Listing active restrictions (todo: API polish) — impose and lift exist,
// but the admin UI has no way to see who is currently restricted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member, Restriction } from '../../src/types.js';

describe('GET /admin/restrictions', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
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
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    bob = await makeMember('Bob');
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('lists active restrictions', async () => {
    await storage.imposeRestriction(bob.id, 'committee decision', alice.id);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/restrictions',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const { restrictions } = res.json() as { restrictions: Restriction[] };
    expect(restrictions).toHaveLength(1);
    expect(restrictions[0]!.memberId).toBe(bob.id);
    expect(restrictions[0]!.reason).toBe('committee decision');
    expect(restrictions[0]!.imposedAt).toBeTruthy();
  });

  it('lifted restrictions disappear from the list', async () => {
    await storage.imposeRestriction(bob.id, 'temporary', alice.id);
    await storage.liftRestriction(bob.id, alice.id);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/restrictions',
      headers: { cookie: adminCookie },
    });
    expect((res.json() as { restrictions: Restriction[] }).restrictions).toEqual([]);
  });

  it('requires the admin role', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/restrictions',
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

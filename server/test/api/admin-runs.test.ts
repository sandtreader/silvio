// Demurrage run history (todo: Admin & governance): admins see when each
// posting ran and completed, newest first.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, DemurrageRun, Group, Member } from '../../src/types.js';

describe('GET /admin/runs', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
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
    const alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    await makeMember('Bob');
    // Two completed runs and one still running.
    await storage.completeDemurrageRun(
      (await storage.beginDemurrageRun(group.id, cams.id, '2026-05')).id,
    );
    await storage.completeDemurrageRun(
      (await storage.beginDemurrageRun(group.id, cams.id, '2026-06')).id,
    );
    await storage.beginDemurrageRun(group.id, cams.id, '2026-07');
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('lists the group’s runs newest first, admin-only', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/runs', headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const { runs } = res.json() as { runs: DemurrageRun[] };
    expect(runs.map((r) => r.period)).toEqual(['2026-07', '2026-06', '2026-05']);
    expect(runs[0]!.status).toBe('running');
    expect(runs[1]!.status).toBe('completed');
    expect(runs[1]!.completedAt).toBeTruthy();

    expect((await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/runs', headers: { cookie: memberCookie },
    })).statusCode).toBe(403);
  });
});

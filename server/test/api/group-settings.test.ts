// Group settings over the API: admins tune autoAcceptDays,
// invoiceExpiryDays and digestDefault via PATCH /admin/group; absent keys
// stay platform defaults.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

describe('group settings API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let adminCookie: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const user = await register(storage, {
      email: 'alice@example.com', password: 'password-1',
    });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice',
      email: 'alice@example.com', userId: user.id,
    });
    const alice: Member = await approve(storage, applied.member.id);
    await storage.updateMember(alice.id, { role: 'admin' });
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'password-1', groupId: group.id,
    });
    adminCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function patch(payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: '/api/v1/g/cam/admin/group',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload,
    });
  }

  it('sets and reads back settings; unset keys are simply absent', async () => {
    const res = await patch({ settings: { autoAcceptDays: 7, digestDefault: 'monthly' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { group: Group }).group.settings).toEqual({
      autoAcceptDays: 7,
      digestDefault: 'monthly',
    });

    const got = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/group', headers: { cookie: adminCookie },
    });
    expect((got.json() as { group: Group }).group.settings).toEqual({
      autoAcceptDays: 7,
      digestDefault: 'monthly',
    });
  });

  it('rejects out-of-range or unknown settings', async () => {
    expect((await patch({ settings: { autoAcceptDays: 0 } })).statusCode).toBe(400);
    expect((await patch({ settings: { invoiceExpiryDays: 366 } })).statusCode).toBe(400);
    expect((await patch({ settings: { digestDefault: 'hourly' } })).statusCode).toBe(400);
    expect((await patch({ settings: { surprise: true } })).statusCode).toBe(400);
  });
});

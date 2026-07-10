// Neighbourhood (todo: Marketplace — the CamLETS location pattern, kept
// deliberately coarse): members set a free-text neighbourhood on their own
// profile; the directory shows it and filters by it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

interface DirectoryEntry {
  displayName: string;
  neighbourhood?: string;
}

describe('neighbourhood field & directory filter', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
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
    const cams: Currency = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    await makeMember('Alice');
    await makeMember('Bob');
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

  it('members set and clear their own neighbourhood via PATCH /me', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/g/cam/me',
      headers: { cookie: bobCookie, origin: 'http://localhost' },
      payload: { neighbourhood: 'Mill Road' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { member: Member }).member.neighbourhood).toBe('Mill Road');

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/v1/g/cam/me',
      headers: { cookie: bobCookie, origin: 'http://localhost' },
      payload: { neighbourhood: null },
    });
    expect((cleared.json() as { member: Member }).member.neighbourhood).toBeUndefined();
  });

  it('the directory shows it and filters by it', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/g/cam/me',
      headers: { cookie: bobCookie, origin: 'http://localhost' },
      payload: { neighbourhood: 'Mill Road' },
    });

    const all = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/members', headers: { cookie: bobCookie },
    });
    const { members } = all.json() as { members: DirectoryEntry[] };
    expect(members.find((m) => m.displayName === 'Bob')!.neighbourhood).toBe('Mill Road');
    expect(members.find((m) => m.displayName === 'Alice')!.neighbourhood).toBeUndefined();

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/g/cam/members?neighbourhood=${encodeURIComponent('Mill Road')}`,
      headers: { cookie: bobCookie },
    });
    const list = (filtered.json() as { members: DirectoryEntry[] }).members;
    expect(list.map((m) => m.displayName)).toEqual(['Bob']);
  });
});

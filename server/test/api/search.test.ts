// GET /search (data-model Search interface): one endpoint, domain-scoped,
// tiered by the caller's session — public visitors search the public face,
// members add the directory, admins see admin pages too.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

interface SearchBody {
  items: { id: string; title: string }[];
  total: number;
}

describe('search API', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
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
    const alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    await makeMember('Bobbington');
    const category = await storage.createCategory({ groupId: group.id, name: 'Food' });
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly veg',
    });
    await storage.createPage({
      groupId: group.id, slug: 'rules', title: 'Committee rules',
      body: 'admin eyes only', visibility: 'admin',
    });
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bobbington');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function search(query: string, cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers['cookie'] = cookie;
    return app.inject({ method: 'GET', url: `/api/v1/g/cam/search?${query}`, headers });
  }

  it('public visitors search listings without a session', async () => {
    const res = await search('domain=listings&q=veg');
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchBody;
    expect(body.total).toBe(1);
    expect(body.items[0]!.title).toBe('Veg box');
  });

  it('the directory is member-tier: hidden logged out, found logged in', async () => {
    expect(((await search('domain=directory&q=bobbington')).json() as SearchBody).total).toBe(0);
    const res = await search('domain=directory&q=bobbington', memberCookie);
    expect((res.json() as SearchBody).total).toBe(1);
  });

  it('admin pages surface only for admins', async () => {
    expect(((await search('domain=pages&q=committee', memberCookie)).json() as SearchBody).total)
      .toBe(0);
    expect(((await search('domain=pages&q=committee', adminCookie)).json() as SearchBody).total)
      .toBe(1);
  });

  it('rejects unknown domains and requires q', async () => {
    expect((await search('domain=ledger&q=x')).statusCode).toBe(400);
    expect((await search('domain=listings')).statusCode).toBe(400);
  });
});

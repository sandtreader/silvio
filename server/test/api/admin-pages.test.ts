// Admin CMS page CRUD (decision #13, data-model §6): admins author markdown
// pages; the brochure renders them (see brochure.test.ts). Slugs are
// url-safe, unique per group (409 on collision).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member, Page } from '../../src/types.js';

describe('admin page CRUD (#13)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let alice: Member; // admin
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
    await makeMember('Bob');
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function create(payload: Record<string, unknown>, cookie = adminCookie) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/admin/pages',
      headers: { cookie, origin: 'http://localhost' },
      payload,
    });
  }

  const draft = {
    slug: 'agreement',
    title: 'Our Agreement',
    body: '# Agreement\n\nBe excellent.',
    visibility: 'public',
  };

  it('admin creates a page', async () => {
    const res = await create(draft);
    expect(res.statusCode).toBe(201);
    const { page } = res.json() as { page: Page };
    expect(page.slug).toBe('agreement');
    expect(page.visibility).toBe('public');
    expect(page.position).toBe(0);
  });

  it('non-admin members are refused', async () => {
    expect((await create(draft, memberCookie)).statusCode).toBe(403);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/admin/pages',
      headers: { cookie: memberCookie },
    });
    expect(list.statusCode).toBe(403);
  });

  it('slugs must be url-safe lowercase', async () => {
    expect((await create({ ...draft, slug: 'Bad Slug!' })).statusCode).toBe(400);
    expect((await create({ ...draft, slug: 'ok-slug-2' })).statusCode).toBe(201);
  });

  it('a duplicate slug is a 409', async () => {
    await create(draft);
    const res = await create({ ...draft, title: 'Again' });
    expect(res.statusCode).toBe(409);
  });

  it('invalid visibility is rejected by the schema', async () => {
    expect((await create({ ...draft, visibility: 'secret' })).statusCode).toBe(400);
  });

  it('lists pages ordered by position, including admin-visibility ones', async () => {
    await create({ ...draft, slug: 'help', title: 'Help', position: 2 });
    await create({ ...draft, slug: 'crisis', title: 'Crisis notes', visibility: 'admin', position: 1 });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/admin/pages',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const { pages } = res.json() as { pages: Page[] };
    expect(pages.map((p) => p.slug)).toEqual(['crisis', 'help']);
  });

  it('updates a page; unknown id is 404', async () => {
    const created = (await create(draft)).json() as { page: Page };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/g/cam/admin/pages/${created.page.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { title: 'The Agreement', visibility: 'members' },
    });
    expect(res.statusCode).toBe(200);
    const { page } = res.json() as { page: Page };
    expect(page.title).toBe('The Agreement');
    expect(page.visibility).toBe('members');

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/g/cam/admin/pages/no-such-id',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { title: 'X' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('deletes a page', async () => {
    const created = (await create(draft)).json() as { page: Page };
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/pages/${created.page.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/admin/pages',
      headers: { cookie: adminCookie },
    });
    expect((list.json() as { pages: Page[] }).pages).toEqual([]);
  });

  it('a page in another group is out of reach', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const page = await storage.createPage({
      groupId: other.id, slug: 'foreign', title: 'Foreign', body: 'x', visibility: 'public',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/g/cam/admin/pages/${page.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { title: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
  });
});

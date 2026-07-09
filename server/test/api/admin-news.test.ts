// Admin news CRUD (decision #13, data-model §6): markdown announcements
// with a published/expires window; the brochure shows current ones.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member, NewsItem } from '../../src/types.js';

describe('admin news CRUD (#13)', () => {
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
      url: '/api/v1/g/cam/admin/news',
      headers: { cookie, origin: 'http://localhost' },
      payload,
    });
  }

  it('admin creates a news item; publishedAt defaults to now', async () => {
    const res = await create({ title: 'Market day', body: 'See you *Saturday*.' });
    expect(res.statusCode).toBe(201);
    const { newsItem } = res.json() as { newsItem: NewsItem };
    expect(newsItem.title).toBe('Market day');
    expect(newsItem.publishedAt).toBeTruthy();
    expect(new Date(newsItem.publishedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('non-admin members are refused', async () => {
    expect((await create({ title: 'X', body: 'Y' }, memberCookie)).statusCode).toBe(403);
  });

  it('lists everything including scheduled and expired, newest first', async () => {
    await create({ title: 'Old', body: 'x', publishedAt: '2026-01-01T00:00:00.000Z' });
    await create({
      title: 'Gone', body: 'x',
      publishedAt: '2026-02-01T00:00:00.000Z', expiresAt: '2026-03-01T00:00:00.000Z',
    });
    await create({ title: 'Later', body: 'x', publishedAt: '2100-01-01T00:00:00.000Z' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/admin/news',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const { news } = res.json() as { news: NewsItem[] };
    expect(news.map((n) => n.title)).toEqual(['Later', 'Gone', 'Old']);
  });

  it('updates and deletes; cross-group ids are 404', async () => {
    const created = (await create({ title: 'Market day', body: 'x' })).json() as {
      newsItem: NewsItem;
    };
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/g/cam/admin/news/${created.newsItem.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      payload: { title: 'Moved', expiresAt: '2026-12-01T00:00:00.000Z' },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { newsItem: NewsItem }).newsItem.title).toBe('Moved');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/news/${created.newsItem.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(del.statusCode).toBe(200);

    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const foreign = await storage.createNewsItem({
      groupId: other.id, title: 'Foreign', body: 'x', publishedAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/news/${foreign.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(404);
  });
});

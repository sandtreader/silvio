// Image upload and serving (decision #14): admins upload CMS images as raw
// request bodies; GET /i/{id} serves bytes with immutable cache headers.
// Access control on /i/ is the unguessable UUID.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Image, Member } from '../../src/types.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 7),
]);

describe('images API (#14)', () => {
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

  function upload(body: Buffer, contentType = 'image/png', cookie = adminCookie) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/admin/images',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': contentType,
      },
      payload: body,
    });
  }

  it('admin uploads a raw image body; the response has metadata, no bytes', async () => {
    const res = await upload(PNG);
    expect(res.statusCode).toBe(201);
    const { image } = res.json() as { image: Image };
    expect(image.id).toBeTruthy();
    expect(image.mime).toBe('image/png');
    expect(image.size).toBe(PNG.length);
    expect(image.ownerKind).toBe('cms');
  });

  it('non-admin members are refused', async () => {
    expect((await upload(PNG, 'image/png', memberCookie)).statusCode).toBe(403);
  });

  it('a bad file is a 400', async () => {
    const res = await upload(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml');
    expect(res.statusCode).toBe(400);
  });

  it('GET /i/{id} serves the bytes, cacheable forever, nosniff', async () => {
    const { image } = (await upload(PNG)).json() as { image: Image };
    const res = await app.inject({ method: 'GET', url: `/i/${image.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.rawPayload, PNG)).toBe(0);
  });

  it('GET /i/ with an unknown id is 404', async () => {
    const res = await app.inject({
      method: 'GET', url: '/i/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('admin lists and deletes CMS images', async () => {
    const { image } = (await upload(PNG)).json() as { image: Image };
    const list = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/images', headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { images: Image[] }).images.map((i) => i.id)).toEqual([image.id]);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/images/${image.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/i/${image.id}` })).statusCode).toBe(404);
  });

  it('a cross-group image cannot be deleted through this group', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const foreign = await storage.createImage({
      groupId: other.id, ownerKind: 'cms', mime: 'image/png', data: PNG, createdBy: 'x',
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/images/${foreign.id}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(404);
  });
});

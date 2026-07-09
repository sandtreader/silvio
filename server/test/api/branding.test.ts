// Group skinning (#15, the #12 follow-up): admins upload a logo and a
// header background image — one per slot, raw body, replace-on-upload —
// and the brochure shell shows them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Image, Member } from '../../src/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(size = 100): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(size - PNG_MAGIC.length, 7)]);
}

describe('group branding API (#15)', () => {
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
    await storage.addGroupDomain(group.id, 'cam.example.org');
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const alice = await makeMember('Alice');
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

  function put(slot: string, cookie = adminCookie, body: Buffer = png()) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/g/cam/admin/branding/${slot}`,
      headers: { cookie, origin: 'http://localhost', 'content-type': 'image/png' },
      payload: body,
    });
  }

  it('admin sets the logo; a second upload replaces it', async () => {
    const first = await put('logo');
    expect(first.statusCode).toBe(200);
    const { image } = first.json() as { image: Image };
    expect(image.ownerKind).toBe('brand');

    const second = (await put('logo', adminCookie, png(60))).json() as { image: Image };
    expect((await app.inject({ method: 'GET', url: `/i/${image.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/i/${second.image.id}` })).statusCode)
      .toBe(200);
  });

  it('non-admins may not touch branding', async () => {
    expect((await put('logo', memberCookie)).statusCode).toBe(403);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/g/cam/admin/branding/logo',
      headers: { cookie: memberCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('only logo and header are slots', async () => {
    expect((await put('favicon')).statusCode).toBe(400);
  });

  it('DELETE clears a slot', async () => {
    const { image } = (await put('header')).json() as { image: Image };
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/g/cam/admin/branding/header',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/i/${image.id}` })).statusCode).toBe(404);
  });

  it('the brochure shell shows the logo and header background', async () => {
    const { image: logo } = (await put('logo')).json() as { image: Image };
    const { image: header } = (await put('header')).json() as { image: Image };
    const res = await app.inject({
      method: 'GET', url: '/', headers: { host: 'cam.example.org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`src="/i/${logo.id}"`);
    expect(res.body).toContain('background-image');
    expect(res.body).toContain(`/i/${header.id}`);
    // Unbranded groups render exactly as before: no empty img or background.
    const market = await app.inject({
      method: 'GET', url: '/market', headers: { host: 'cam.example.org' },
    });
    expect(market.body).toContain(`src="/i/${logo.id}"`);
  });

  it('GET /admin/images?ownerKind=brand lists the brand slots', async () => {
    const { image: logo } = (await put('logo')).json() as { image: Image };
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/admin/images?ownerKind=brand',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    const { images } = res.json() as { images: Image[] };
    expect(images.map((i) => i.id)).toEqual([logo.id]);
    expect(images[0]!.ownerId).toBe('logo');
    // The default stays 'cms': the Images page never sees brand images.
    const cms = await app.inject({
      method: 'GET',
      url: '/api/v1/g/cam/admin/images',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect((cms.json() as { images: Image[] }).images).toEqual([]);
  });

  it('an unbranded group has no logo markup', async () => {
    const res = await app.inject({
      method: 'GET', url: '/', headers: { host: 'cam.example.org' },
    });
    expect(res.body).not.toContain('shell-logo');
    expect(res.body).not.toContain('background-image');
  });
});

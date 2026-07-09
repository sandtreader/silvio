// Member profile photo (#14 phase 2): a member uploads exactly one photo —
// raw body to POST /me/photo, replace-on-upload, 256KB cap — and photoId
// surfaces on /me and the member directory.

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

describe('member photo API (#14 phase 2)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let bob: Member;
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
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    await makeMember('Alice');
    bob = await makeMember('Bob');
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

  // cookie: '' sends no session at all (an explicit `undefined` argument
  // would trigger the default — a trap this test file fell into once).
  function upload(body: Buffer, cookie: string = bobCookie) {
    const headers: Record<string, string> = {
      origin: 'http://localhost', 'content-type': 'image/png',
    };
    if (cookie !== '') headers['cookie'] = cookie;
    return app.inject({
      method: 'POST', url: '/api/v1/g/cam/me/photo', headers, payload: body,
    });
  }

  async function myPhotoId(): Promise<string | undefined> {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie: bobCookie },
    });
    return (res.json() as { member: { photoId?: string } }).member.photoId;
  }

  it('uploads a photo; /me carries its photoId', async () => {
    const res = await upload(png());
    expect(res.statusCode).toBe(201);
    const { image } = res.json() as { image: Image };
    expect(image.ownerKind).toBe('member');
    expect(await myPhotoId()).toBe(image.id);
  });

  it('a second upload replaces the first', async () => {
    const first = (await upload(png(50))).json() as { image: Image };
    const second = (await upload(png(60))).json() as { image: Image };
    expect(await myPhotoId()).toBe(second.image.id);
    expect((await app.inject({ method: 'GET', url: `/i/${first.image.id}` })).statusCode)
      .toBe(404);
    expect((await app.inject({ method: 'GET', url: `/i/${second.image.id}` })).statusCode)
      .toBe(200);
  });

  it('the directory shows who has a photo', async () => {
    const { image } = (await upload(png())).json() as { image: Image };
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/members', headers: { cookie: bobCookie },
    });
    const { members } = res.json() as {
      members: { displayName: string; photoId?: string }[];
    };
    expect(members.find((m) => m.displayName === 'Bob')?.photoId).toBe(image.id);
    expect(members.find((m) => m.displayName === 'Alice')?.photoId).toBeUndefined();
  });

  it('DELETE /me/photo removes it everywhere', async () => {
    const { image } = (await upload(png())).json() as { image: Image };
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/g/cam/me/photo',
      headers: { cookie: bobCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPhotoId()).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/i/${image.id}` })).statusCode).toBe(404);
  });

  it('needs a session', async () => {
    expect((await upload(png(), '')).statusCode).toBe(401);
  });

  it('the 256KB member cap applies', async () => {
    const res = await upload(png(300 * 1024));
    expect(res.statusCode).toBe(422);
  });
});

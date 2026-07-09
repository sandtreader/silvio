// Listing photos (#14 phase 3): the listing owner attaches up to five
// photos (raw body, 1MB cap); photoIds ride on listing responses in upload
// order; the brochure market shows them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Image, Listing, Member } from '../../src/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(size = 100): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(size - PNG_MAGIC.length, 7)]);
}

describe('listing photos API (#14 phase 3)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let alice: Member;
  let listing: Listing;
  let aliceCookie: string;
  let bobCookie: string;

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
    await makeMember('Bob');
    const category = await storage.createCategory({ groupId: group.id, name: 'Food' });
    listing = await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly',
    });
    app = await buildApp(storage);
    await app.ready();
    aliceCookie = await cookieFor('Alice');
    bobCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function upload(cookie: string, body: Buffer = png()) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/g/cam/listings/${listing.id}/photos`,
      headers: { cookie, origin: 'http://localhost', 'content-type': 'image/png' },
      payload: body,
    });
  }

  it('the owner uploads a photo; browse carries photoIds in upload order', async () => {
    const first = (await upload(aliceCookie, png(50))).json() as { image: Image };
    const res = await upload(aliceCookie, png(60));
    expect(res.statusCode).toBe(201);
    const second = res.json() as { image: Image };

    const browseRes = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/listings', headers: { cookie: bobCookie },
    });
    const { listings } = browseRes.json() as {
      listings: { id: string; photoIds: string[] }[];
    };
    const mine = listings.find((l) => l.id === listing.id);
    expect(mine?.photoIds).toEqual([first.image.id, second.image.id]);
  });

  it('non-owners may not attach or remove', async () => {
    expect((await upload(bobCookie)).statusCode).toBe(403);
    const { image } = (await upload(aliceCookie)).json() as { image: Image };
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/listings/${listing.id}/photos/${image.id}`,
      headers: { cookie: bobCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('the owner removes a photo', async () => {
    const { image } = (await upload(aliceCookie)).json() as { image: Image };
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/listings/${listing.id}/photos/${image.id}`,
      headers: { cookie: aliceCookie, origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/i/${image.id}` })).statusCode).toBe(404);
  });

  it('the sixth photo is refused', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await upload(aliceCookie, png(50 + i))).statusCode).toBe(201);
    }
    expect((await upload(aliceCookie, png(200))).statusCode).toBe(422);
  });

  it('the brochure market shows listing photos', async () => {
    await storage.addGroupDomain(group.id, 'cam.example.org');
    const { image } = (await upload(aliceCookie)).json() as { image: Image };
    const res = await app.inject({
      method: 'GET', url: '/market', headers: { host: 'cam.example.org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`src="/i/${image.id}"`);
  });
});

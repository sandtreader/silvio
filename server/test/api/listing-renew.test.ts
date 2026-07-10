// Listing renewal over the API (#18): the owner resets the shelf life
// with one POST; anyone else is refused.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Listing, Member } from '../../src/types.js';

describe('listing renew API (#18)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
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
    const alice = await makeMember('Alice');
    await makeMember('Bob');
    const category = await storage.createCategory({ groupId: group.id, name: 'Food' });
    listing = await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly',
      expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
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

  function renew(cookie: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/g/cam/listings/${listing.id}/renew`,
      headers: { cookie, origin: 'http://localhost' },
    });
  }

  it('the owner renews; the expiry moves out to a full shelf life', async () => {
    const res = await renew(aliceCookie);
    expect(res.statusCode).toBe(200);
    const { listing: renewed } = res.json() as { listing: Listing };
    expect(Date.parse(renewed.expiresAt!) - Date.now()).toBeGreaterThan(100 * 86_400_000);
  });

  it('non-owners may not renew', async () => {
    expect((await renew(bobCookie)).statusCode).toBe(403);
  });
});

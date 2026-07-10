// Qualified/professional listing badges (todo: Marketplace; #8's one
// blessed reputation surface — admin-VERIFIED facts, not peer ratings).
// Only admins set them; the market and brochure display them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Listing, Member } from '../../src/types.js';

describe('listing badges (#8)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let listing: Listing;
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
    const cams: Currency = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    const bob = await makeMember('Bob');
    const category = await storage.createCategory({ groupId: group.id, name: 'Trades' });
    listing = await postListing(storage, bob.id, {
      type: 'offer', categoryId: category.id, title: 'Electrics', description: 'Rewiring',
    });
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function setBadges(badges: string[], cookie = adminCookie) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/g/cam/admin/listings/${listing.id}/badges`,
      headers: { cookie, origin: 'http://localhost' },
      payload: { badges },
    });
  }

  it('admins set and clear badges; browse carries them; audited', async () => {
    const res = await setBadges(['professional', 'qualified']);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { listing: Listing }).listing.badges)
      .toEqual(['professional', 'qualified']);

    const browse = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/listings', headers: { cookie: memberCookie },
    });
    const { listings } = browse.json() as { listings: Listing[] };
    expect(listings[0]!.badges).toEqual(['professional', 'qualified']);

    await setBadges([]);
    const after = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/listings', headers: { cookie: memberCookie },
    });
    expect((after.json() as { listings: Listing[] }).listings[0]!.badges).toEqual([]);

    expect((await storage.listAuditEvents(group.id, { action: 'listing.badges' })).total)
      .toBe(2);
  });

  it('owners cannot bless themselves; unknown badges are refused', async () => {
    expect((await setBadges(['professional'], memberCookie)).statusCode).toBe(403);
    expect((await setBadges(['celebrity'])).statusCode).toBe(400);
  });

  it('the brochure market shows the badges', async () => {
    await setBadges(['qualified']);
    const res = await app.inject({
      method: 'GET', url: '/market', headers: { host: 'cam.example.org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('qualified');
  });
});

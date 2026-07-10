// Listing shelf life (#18): posted listings expire by default after the
// group's listingMaxAgeDays; the sweep warns owners 14 days out, expires
// on the day, and purges (row + photos) 90 days later. Renewing resets
// the clock and revives within the purge window.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { postListing, renewListing, sweepListings } from '../../src/services/marketplace.js';
import { addListingPhoto } from '../../src/services/images.js';
import { apply, approve } from '../../src/services/membership.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Category, Group, Member } from '../../src/types.js';

const DAY = 86_400_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(50, 7)]);
}

describe('listing shelf life (#18)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let alice: Member;
  let bob: Member;
  let category: Category;
  const now = new Date().toISOString();

  function daysAway(days: number): string {
    return new Date(Date.parse(now) + days * DAY).toISOString();
  }

  async function member(name: string): Promise<Member> {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: name, personName: name,
      email: `${name.toLowerCase()}@example.com`,
    });
    return approve(storage, member.id);
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    const cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams' });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await member('Alice');
    bob = await member('Bob');
    category = await storage.createCategory({ groupId: group.id, name: 'Food' });
  });

  afterEach(() => {
    storage.close();
  });

  function post(overrides: Record<string, unknown> = {}) {
    return postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly',
      ...overrides,
    });
  }

  it('new listings default to the group’s shelf life; explicit expiry wins', async () => {
    const listing = await post();
    const horizon = Date.parse(listing.expiresAt!) - Date.now();
    expect(horizon).toBeGreaterThan(179 * DAY);
    expect(horizon).toBeLessThan(181 * DAY);

    await storage.updateGroup(group.id, { settings: { listingMaxAgeDays: 30 } });
    const short = await post({ title: 'Short-lived' });
    const shortHorizon = Date.parse(short.expiresAt!) - Date.now();
    expect(shortHorizon).toBeGreaterThan(29 * DAY);
    expect(shortHorizon).toBeLessThan(31 * DAY);

    const explicit = await post({ title: 'Explicit', expiresAt: daysAway(3) });
    expect(explicit.expiresAt).toBe(daysAway(3));
  });

  it('the sweep warns owners 14 days out, once per expiry date', async () => {
    await post({ expiresAt: daysAway(10) });
    await post({ title: 'Far out', expiresAt: daysAway(60) });

    const report = await sweepListings(storage, group.id, now);
    expect(report.warned).toBe(1);
    const events = (await storage.pendingEmails(10)).filter(
      (e) => e.kind === 'listing_expiry_warning',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.toEmail).toBe('alice@example.com');
    expect(events[0]!.body).toContain('Veg box');

    // Idempotent: the next sweep warns nobody new.
    expect((await sweepListings(storage, group.id, now)).warned).toBe(0);
  });

  it('renew resets the clock and revives an expired listing', async () => {
    const listing = await post({ expiresAt: daysAway(3) });
    const renewed = await renewListing(storage, listing.id, alice.id);
    const horizon = Date.parse(renewed.expiresAt!) - Date.now();
    expect(horizon).toBeGreaterThan(179 * DAY);
    expect(renewed.status).toBe('active');

    // Only the owner may renew.
    await expect(renewListing(storage, listing.id, bob.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === 'NOT_AUTHORISED',
    );

    // An expired (but unpurged) listing comes back to life.
    await storage.updateListing(listing.id, { status: 'expired', expiresAt: daysAway(-5) });
    const revived = await renewListing(storage, listing.id, alice.id);
    expect(revived.status).toBe('active');
    expect(Date.parse(revived.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('the sweep purges listings 90 days after expiry, photos included', async () => {
    const stale = await post({ expiresAt: daysAway(-91) });
    await addListingPhoto(storage, stale.id, alice.id, 'image/png', png());
    const fresh = await post({ title: 'Recently expired', expiresAt: daysAway(-30) });

    const report = await sweepListings(storage, group.id, now);
    expect(report.purged).toBe(1);

    const remaining = await storage.listListings(group.id, {});
    expect(remaining.map((l) => l.id)).toEqual([fresh.id]);
    expect(await storage.listImages(group.id, { ownerKind: 'listing', ownerId: stale.id }))
      .toEqual([]);
  });
});

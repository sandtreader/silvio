// Marketplace service: categorised offers & wants with scheduling; away
// members' listings are hidden (decision #7).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  postListing,
  editListing,
  endListing,
  browse,
  sweepListings,
} from '../../src/services/marketplace.js';
import { apply, approve, setAway } from '../../src/services/membership.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Category, Currency, Group, Member } from '../../src/types.js';

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code,
    `expected DomainError ${code}`,
  );
}

describe('marketplace service', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let gardening: Category;
  let tuition: Category;
  let alice: Member;
  let bob: Member;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    gardening = await storage.createCategory({ groupId: group.id, name: 'Gardening' });
    tuition = await storage.createCategory({ groupId: group.id, name: 'Tuition' });
    const a = await apply(storage, { groupId: group.id, displayName: 'Alice', personName: 'A' });
    alice = await approve(storage, a.member.id);
    const b = await apply(storage, { groupId: group.id, displayName: 'Bob', personName: 'B' });
    bob = await approve(storage, b.member.id);
  });

  afterEach(() => {
    storage.close();
  });

  it('supports hierarchical categories', async () => {
    const veg = await storage.createCategory({
      groupId: group.id, name: 'Vegetables', parentId: gardening.id,
    });
    expect(veg.parentId).toBe(gardening.id);
    expect(await storage.listCategories(group.id)).toHaveLength(3);
  });

  it('an active member posts an offer with a price or free-text rate', async () => {
    const priced = await postListing(storage, alice.id, {
      type: 'offer', title: 'Veg boxes', description: 'Weekly seasonal veg',
      categoryId: gardening.id, priceAmount: 500, priceCurrencyId: cams.id,
    });
    expect(priced.status).toBe('active');
    const rated = await postListing(storage, alice.id, {
      type: 'want', title: 'Spanish lessons', description: 'Beginner',
      categoryId: tuition.id, rateText: 'negotiable',
    });
    expect(rated.rateText).toBe('negotiable');
  });

  it('applied and suspended members cannot post', async () => {
    const c = await apply(storage, { groupId: group.id, displayName: 'C', personName: 'C' });
    await expectDomainError(
      postListing(storage, c.member.id, {
        type: 'offer', title: 'X', description: 'X', categoryId: gardening.id,
      }),
      'WRONG_STATE',
    );
  });

  it('browse filters by type and category', async () => {
    await postListing(storage, alice.id, {
      type: 'offer', title: 'Veg boxes', description: 'x', categoryId: gardening.id,
    });
    await postListing(storage, alice.id, {
      type: 'want', title: 'Pruning help', description: 'x', categoryId: gardening.id,
    });
    await postListing(storage, bob.id, {
      type: 'offer', title: 'Maths tuition', description: 'x', categoryId: tuition.id,
    });
    expect(await browse(storage, group.id, { type: 'offer' })).toHaveLength(2);
    expect(await browse(storage, group.id, { categoryId: gardening.id })).toHaveLength(2);
    expect(
      await browse(storage, group.id, { type: 'offer', categoryId: tuition.id }),
    ).toHaveLength(1);
  });

  it("an away member's listings are hidden from browse and return on reactivation (#7)", async () => {
    await postListing(storage, alice.id, {
      type: 'offer', title: 'Veg boxes', description: 'x', categoryId: gardening.id,
    });
    await postListing(storage, bob.id, {
      type: 'offer', title: 'Maths tuition', description: 'x', categoryId: tuition.id,
    });
    await setAway(storage, alice.id, true);
    const visible = await browse(storage, group.id, { type: 'offer' });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.memberId).toBe(bob.id);
    await setAway(storage, alice.id, false);
    expect(await browse(storage, group.id, { type: 'offer' })).toHaveLength(2);
  });

  it('only the owner may edit or end a listing', async () => {
    const listing = await postListing(storage, alice.id, {
      type: 'offer', title: 'Veg boxes', description: 'x', categoryId: gardening.id,
    });
    await expectDomainError(
      editListing(storage, listing.id, bob.id, { title: 'Hijacked' }),
      'NOT_AUTHORISED',
    );
    const edited = await editListing(storage, listing.id, alice.id, { title: 'Veg & fruit boxes' });
    expect(edited.title).toBe('Veg & fruit boxes');
    await expectDomainError(endListing(storage, listing.id, bob.id), 'NOT_AUTHORISED');
    const ended = await endListing(storage, listing.id, alice.id);
    expect(ended.status).toBe('expired');
    expect(await browse(storage, group.id, {})).toHaveLength(0);
  });

  it('sweep expires listings past their expiry date', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await postListing(storage, alice.id, {
      type: 'offer', title: 'Old', description: 'x', categoryId: gardening.id, expiresAt: past,
    });
    await postListing(storage, alice.id, {
      type: 'offer', title: 'Fresh', description: 'x', categoryId: gardening.id, expiresAt: future,
    });
    const result = await sweepListings(storage, group.id, new Date().toISOString());
    expect(result.expired).toBe(1);
    const visible = await browse(storage, group.id, {});
    expect(visible).toHaveLength(1);
    expect(visible[0]!.title).toBe('Fresh');
  });

  it('rejects listings in unknown categories', async () => {
    await expectDomainError(
      postListing(storage, alice.id, {
        type: 'offer', title: 'X', description: 'X', categoryId: 'nope',
      }),
      'NOT_FOUND',
    );
  });
});

// Marketplace service: categorised offers & wants. Away members' listings
// are hidden at view time and return on reactivation (decision #7).
// Listings have a shelf life (#18): a default expiry at post time, a
// warning email ahead of expiry, one-tap renewal, and a purge 90 days on.

import type { Storage } from '../storage/interface.js';
import type { Id, Listing, ListingType, Member } from '../types.js';
import { DomainError } from './errors.js';
import { notifyListingExpiryWarning } from './notifications.js';
import { effectiveSettings } from './settings.js';

const DAY_MS = 86_400_000;
const WARN_AHEAD_DAYS = 14; // expiry warning horizon (#18)
export const PURGE_AFTER_DAYS = 90; // hard-delete this long after expiry (#18)

export interface PostListingInput {
  type: ListingType;
  title: string;
  description: string;
  categoryId: Id;
  priceAmount?: number;
  priceCurrencyId?: Id;
  rateText?: string;
  expiresAt?: string;
}

export type ListingPatch = Partial<{
  title: string;
  description: string;
  categoryId: Id;
  priceAmount: number;
  priceCurrencyId: Id;
  rateText: string;
  expiresAt: string;
}>;

export interface BrowseFilter {
  type?: ListingType;
  categoryId?: Id;
}

async function ownedListing(storage: Storage, listingId: Id, actorMemberId: Id): Promise<Listing> {
  const listing = await storage.getListing(listingId);
  if (listing.memberId !== actorMemberId) {
    throw new DomainError('NOT_AUTHORISED', 'only the listing owner may do this');
  }
  return listing;
}

/** The group's listing shelf life (#18), in milliseconds. */
async function shelfLifeMs(storage: Storage, groupId: Id): Promise<number> {
  const group = (await storage.listGroups()).find((candidate) => candidate.id === groupId);
  if (group === undefined) throw new DomainError('NOT_FOUND', `group ${groupId} not found`);
  return effectiveSettings(group).listingMaxAgeDays * DAY_MS;
}

/** Only active members may post; the category must exist in their group. */
export async function postListing(
  storage: Storage,
  memberId: Id,
  input: PostListingInput,
): Promise<Listing> {
  const member = await storage.getMember(memberId);
  if (member.status !== 'active') {
    throw new DomainError(
      'WRONG_STATE',
      `${member.displayName} is ${member.status} and cannot post listings`,
    );
  }
  const categories = await storage.listCategories(member.groupId);
  if (!categories.some((category) => category.id === input.categoryId)) {
    throw new DomainError('NOT_FOUND', `category ${input.categoryId} not found in this group`);
  }
  const createInput: Parameters<Storage['createListing']>[0] = {
    groupId: member.groupId,
    memberId,
    type: input.type,
    title: input.title,
    description: input.description,
    categoryId: input.categoryId,
  };
  if (input.priceAmount !== undefined) createInput.priceAmount = input.priceAmount;
  if (input.priceCurrencyId !== undefined) createInput.priceCurrencyId = input.priceCurrencyId;
  if (input.rateText !== undefined) createInput.rateText = input.rateText;
  // An explicit expiry wins; absent means the group's shelf life (#18).
  createInput.expiresAt =
    input.expiresAt ??
    new Date(Date.now() + (await shelfLifeMs(storage, member.groupId))).toISOString();
  return storage.createListing(createInput);
}

/**
 * Owner-only renewal (#18): a fresh full shelf life from now, and back to
 * active — within the purge window this revives an expired listing (after
 * the purge the row is gone, so there is no special case).
 */
export async function renewListing(
  storage: Storage,
  listingId: Id,
  actorMemberId: Id,
): Promise<Listing> {
  const listing = await ownedListing(storage, listingId, actorMemberId);
  const expiresAt = new Date(
    Date.now() + (await shelfLifeMs(storage, listing.groupId)),
  ).toISOString();
  return storage.updateListing(listingId, { status: 'active', expiresAt });
}

export async function editListing(
  storage: Storage,
  listingId: Id,
  actorMemberId: Id,
  patch: ListingPatch,
): Promise<Listing> {
  await ownedListing(storage, listingId, actorMemberId);
  return storage.updateListing(listingId, patch);
}

export async function endListing(
  storage: Storage,
  listingId: Id,
  actorMemberId: Id,
): Promise<Listing> {
  await ownedListing(storage, listingId, actorMemberId);
  return storage.updateListing(listingId, { status: 'expired' });
}

/**
 * Active listings matching the filter, excluding listings whose member is
 * not currently active — a view-time filter, not stored state (decision #7).
 */
export async function browse(
  storage: Storage,
  groupId: Id,
  filter: BrowseFilter,
): Promise<Listing[]> {
  const listFilter: { type?: ListingType; categoryId?: Id; status: 'active' } = {
    status: 'active',
  };
  if (filter.type !== undefined) listFilter.type = filter.type;
  if (filter.categoryId !== undefined) listFilter.categoryId = filter.categoryId;
  const listings = await storage.listListings(groupId, listFilter);
  const members = new Map<Id, Member>();
  const visible: Listing[] = [];
  for (const listing of listings) {
    let member = members.get(listing.memberId);
    if (member === undefined) {
      member = await storage.getMember(listing.memberId);
      members.set(listing.memberId, member);
    }
    if (member.status === 'active') visible.push(listing);
  }
  return visible;
}

/**
 * The shelf-life sweep (#18): warn owners WARN_AHEAD_DAYS before expiry
 * (once per expiry date, via the notification dedup), expire past-due
 * active listings, and purge — row plus photos — PURGE_AFTER_DAYS on.
 */
export async function sweepListings(
  storage: Storage,
  groupId: Id,
  asOf: string,
): Promise<{ expired: number; warned: number; purged: number }> {
  const report = { expired: 0, warned: 0, purged: 0 };
  const asOfMs = Date.parse(asOf);
  const listings = await storage.listListings(groupId, {}); // every status

  for (const listing of listings) {
    if (listing.status !== 'active' || listing.expiresAt === undefined) continue;
    const expiresMs = Date.parse(listing.expiresAt);
    if (expiresMs > asOfMs && expiresMs <= asOfMs + WARN_AHEAD_DAYS * DAY_MS) {
      if (await notifyListingExpiryWarning(storage, listing, asOf)) report.warned += 1;
    }
  }

  for (const listing of listings) {
    if (listing.status === 'active' && listing.expiresAt !== undefined
        && listing.expiresAt <= asOf) {
      await storage.updateListing(listing.id, { status: 'expired' });
      report.expired += 1;
    }
  }

  for (const listing of listings) {
    if (listing.expiresAt === undefined) continue;
    if (Date.parse(listing.expiresAt) < asOfMs - PURGE_AFTER_DAYS * DAY_MS) {
      const photos = await storage.listImages(groupId, {
        ownerKind: 'listing',
        ownerId: listing.id,
      });
      for (const photo of photos) await storage.deleteImage(photo.id);
      await storage.deleteListing(listing.id);
      report.purged += 1;
    }
  }
  return report;
}

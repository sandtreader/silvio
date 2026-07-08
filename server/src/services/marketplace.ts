// Marketplace service: categorised offers & wants. Away members' listings
// are hidden at view time and return on reactivation (decision #7).

import type { Storage } from '../storage/interface.js';
import type { Id, Listing, ListingType, Member } from '../types.js';
import { DomainError } from './errors.js';

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
  if (input.expiresAt !== undefined) createInput.expiresAt = input.expiresAt;
  return storage.createListing(createInput);
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
  const listFilter: { type?: ListingType; categoryId?: Id } = {};
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

/** Expire active listings past their expiry date. */
export async function sweepListings(
  storage: Storage,
  groupId: Id,
  asOf: string,
): Promise<{ expired: number }> {
  let expired = 0;
  for (const listing of await storage.listListings(groupId)) {
    if (listing.expiresAt !== undefined && listing.expiresAt <= asOf) {
      await storage.updateListing(listing.id, { status: 'expired' });
      expired += 1;
    }
  }
  return { expired };
}

// Image upload validation (decision #14): the client resizes, the server
// validates. Magic-byte sniff against a jpeg/png/webp whitelist (the claimed
// mime must match what the bytes actually are), hard per-owner-kind byte
// caps, and a per-group total quota. Limits are injectable so tests don't
// build 500MB buffers; the defaults are #14's numbers.

import type { Storage } from '../storage/interface.js';
import type { BrandSlot, Image, ImageOwnerKind } from '../types.js';
import { DomainError } from './errors.js';

/**
 * Per-owner-kind byte caps and the group-wide quota (decision #14). Caps are
 * Partial so callers may override just the kinds they care about; anything
 * omitted falls back to the default for that kind.
 */
export interface ImageLimits {
  sizeCaps?: Partial<Record<ImageOwnerKind, number>>;
  groupQuota?: number;
}

const DEFAULT_SIZE_CAPS: Record<ImageOwnerKind, number> = {
  cms: 2 * 1024 * 1024, // 2MB
  member: 256 * 1024, // 256KB
  listing: 1024 * 1024, // 1MB
  brand: 1024 * 1024, // 1MB (#15)
};

// Group quota: a constant for now, a per-group plan setting later (#2, #14).
const DEFAULT_GROUP_QUOTA = 500 * 1024 * 1024; // 500MB

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * What the bytes actually are, by magic number — png/jpeg/webp only, the
 * whole whitelist (#14). Anything else (gif, svg, non-images) is undefined.
 */
function sniff(data: Buffer): string | undefined {
  if (data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (data.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  // webp: a RIFF container whose form type (bytes 8-11) is WEBP.
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface UploadImageInput {
  groupId: string;
  ownerKind: ImageOwnerKind;
  ownerId?: string;
  mime: string;
  data: Buffer;
  createdBy: string;
}

/**
 * Validate and store an image (#14): the sniffed type must equal the claimed
 * mime and be whitelisted (INVALID otherwise); the bytes must fit the
 * owner-kind cap and the group quota (LIMIT_BREACHED, stating the rule).
 */
export async function uploadImage(
  storage: Storage,
  input: UploadImageInput,
  limits: ImageLimits = {},
): Promise<Image> {
  const sniffed = sniff(input.data);
  if (sniffed === undefined || sniffed !== input.mime) {
    throw new DomainError(
      'INVALID',
      'images must be PNG, JPEG or WebP, and the file content must match its declared type',
    );
  }

  const cap = limits.sizeCaps?.[input.ownerKind] ?? DEFAULT_SIZE_CAPS[input.ownerKind];
  if (input.data.length > cap) {
    throw new DomainError(
      'LIMIT_BREACHED',
      `this image is ${input.data.length} bytes; ${input.ownerKind} images may be at most ${cap} bytes`,
    );
  }

  const quota = limits.groupQuota ?? DEFAULT_GROUP_QUOTA;
  const used = await storage.imagesTotalSize(input.groupId);
  if (used + input.data.length > quota) {
    throw new DomainError(
      'LIMIT_BREACHED',
      `this image would take the group's image storage over its ${quota}-byte quota (${used} bytes already used)`,
    );
  }

  const create: Parameters<typeof storage.createImage>[0] = {
    groupId: input.groupId,
    ownerKind: input.ownerKind,
    mime: input.mime,
    data: input.data,
    createdBy: input.createdBy,
  };
  if (input.ownerId !== undefined) create.ownerId = input.ownerId;
  return storage.createImage(create);
}

/**
 * Set a member's profile photo (#14 phase 2): exactly one per member,
 * replace-on-upload. The new image is created first and any previous
 * photo(s) deleted after, so a failed upload never loses the old photo.
 * The 256KB member cap applies via sizeCaps.member.
 */
export async function setMemberPhoto(
  storage: Storage,
  memberId: string,
  mime: string,
  data: Buffer,
  limits: ImageLimits = {},
): Promise<Image> {
  const member = await storage.getMember(memberId);
  const previous = await storage.listImages(member.groupId, {
    ownerKind: 'member',
    ownerId: memberId,
  });
  const image = await uploadImage(
    storage,
    {
      groupId: member.groupId,
      ownerKind: 'member',
      ownerId: memberId,
      mime,
      data,
      createdBy: memberId,
    },
    limits,
  );
  for (const old of previous) await storage.deleteImage(old.id);
  return image;
}

// Listing photo ceiling (#14 phase 3): up to five photos per listing.
const MAX_LISTING_PHOTOS = 5;

/**
 * Attach a photo to a listing (#14 phase 3): only the listing's owner may,
 * at most five per listing, and the 1MB listing cap applies via
 * sizeCaps.listing.
 */
export async function addListingPhoto(
  storage: Storage,
  listingId: string,
  actorMemberId: string,
  mime: string,
  data: Buffer,
  limits: ImageLimits = {},
): Promise<Image> {
  const listing = await storage.getListing(listingId);
  if (listing.memberId !== actorMemberId) {
    throw new DomainError('NOT_AUTHORISED', 'only the listing owner may manage its photos');
  }
  const existing = await storage.listImages(listing.groupId, {
    ownerKind: 'listing',
    ownerId: listingId,
  });
  if (existing.length >= MAX_LISTING_PHOTOS) {
    throw new DomainError(
      'LIMIT_BREACHED',
      `a listing may carry at most ${MAX_LISTING_PHOTOS} photos`,
    );
  }
  return uploadImage(
    storage,
    {
      groupId: listing.groupId,
      ownerKind: 'listing',
      ownerId: listingId,
      mime,
      data,
      createdBy: actorMemberId,
    },
    limits,
  );
}

/**
 * Remove a listing photo (#14 phase 3): owner-only, and the image must
 * actually belong to that listing (NOT_FOUND otherwise — a foreign image id
 * looks exactly like a missing one).
 */
export async function removeListingPhoto(
  storage: Storage,
  listingId: string,
  imageId: string,
  actorMemberId: string,
): Promise<void> {
  const listing = await storage.getListing(listingId);
  if (listing.memberId !== actorMemberId) {
    throw new DomainError('NOT_AUTHORISED', 'only the listing owner may manage its photos');
  }
  const image = await storage.getImage(imageId);
  if (image.ownerKind !== 'listing' || image.ownerId !== listingId) {
    throw new DomainError('NOT_FOUND', `image ${imageId} not found on this listing`);
  }
  await storage.deleteImage(imageId);
}

/**
 * Every listing photo in the group, keyed by listing id, in upload order
 * (#14 phase 3): one query to annotate a whole page of listings with their
 * derived photoIds. listImages orders by created_at then id (uuidv7), so
 * each list is deterministic upload order.
 */
export async function listingPhotoIds(
  storage: Storage,
  groupId: string,
): Promise<Map<string, string[]>> {
  const images = await storage.listImages(groupId, { ownerKind: 'listing' });
  const byListing = new Map<string, string[]>();
  for (const image of images) {
    if (image.ownerId === undefined) continue;
    const ids = byListing.get(image.ownerId) ?? [];
    ids.push(image.id);
    byListing.set(image.ownerId, ids);
  }
  return byListing;
}

/**
 * Set a group's brand image for a slot (#15): exactly one per slot,
 * replace-on-upload. Create-first-delete-after, exactly as setMemberPhoto —
 * a failed upload never loses the old image. The 1MB brand cap applies via
 * sizeCaps.brand.
 */
export async function setBrandImage(
  storage: Storage,
  groupId: string,
  slot: BrandSlot,
  mime: string,
  data: Buffer,
  createdBy: string,
  limits: ImageLimits = {},
): Promise<Image> {
  const previous = await storage.listImages(groupId, {
    ownerKind: 'brand',
    ownerId: slot,
  });
  const image = await uploadImage(
    storage,
    { groupId, ownerKind: 'brand', ownerId: slot, mime, data, createdBy },
    limits,
  );
  for (const old of previous) await storage.deleteImage(old.id);
  return image;
}

/** Clear a group's brand slot (#15); a no-op when the slot is empty. */
export async function deleteBrandImage(
  storage: Storage,
  groupId: string,
  slot: BrandSlot,
): Promise<void> {
  const images = await storage.listImages(groupId, { ownerKind: 'brand', ownerId: slot });
  for (const image of images) await storage.deleteImage(image.id);
}

/** A group's skin (#15): the image id per slot, keys absent for empty slots. */
export interface Branding {
  logoImageId?: string;
  headerImageId?: string;
}

/**
 * The group's branding in one query (#15): every brand-owned image, mapped
 * slot -> id. Keys are set conditionally (exactOptionalPropertyTypes) so an
 * unbranded group is exactly {}.
 */
export async function brandingFor(storage: Storage, groupId: string): Promise<Branding> {
  const images = await storage.listImages(groupId, { ownerKind: 'brand' });
  const branding: Branding = {};
  for (const image of images) {
    if (image.ownerId === 'logo') branding.logoImageId = image.id;
    if (image.ownerId === 'header') branding.headerImageId = image.id;
  }
  return branding;
}

/** Delete a member's profile photo(s) (#14 phase 2); a no-op when none. */
export async function deleteMemberPhoto(storage: Storage, memberId: string): Promise<void> {
  const member = await storage.getMember(memberId);
  const photos = await storage.listImages(member.groupId, {
    ownerKind: 'member',
    ownerId: memberId,
  });
  for (const photo of photos) await storage.deleteImage(photo.id);
}

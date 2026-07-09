// Image upload validation (decision #14): the client resizes, the server
// validates — magic-byte sniff against a jpeg/png/webp whitelist, per-kind
// size caps, and a per-group quota. Limits are injectable so tests don't
// build 500MB buffers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uploadImage } from '../../src/services/images.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group } from '../../src/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(50, 0),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(50, 0)]);

function png(size = 100): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(size - PNG_MAGIC.length, 1)]);
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code,
    `expected DomainError ${code}`,
  );
}

describe('uploadImage (#14)', () => {
  let storage: SqliteStorage;
  let group: Group;

  function draft(overrides: Record<string, unknown> = {}) {
    return {
      groupId: group.id,
      ownerKind: 'cms' as const,
      mime: 'image/png',
      data: png(),
      createdBy: 'person-alice',
      ...overrides,
    };
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
  });

  afterEach(() => {
    storage.close();
  });

  it('accepts png, jpeg and webp whose bytes match the claimed mime', async () => {
    const stored = await uploadImage(storage, draft());
    expect(stored.mime).toBe('image/png');
    await uploadImage(storage, draft({
      mime: 'image/jpeg', data: Buffer.concat([JPEG_MAGIC, Buffer.alloc(50, 0)]),
    }));
    await uploadImage(storage, draft({ mime: 'image/webp', data: WEBP }));
    expect(await storage.listImages(group.id, {})).toHaveLength(3);
  });

  it('rejects a mime/magic mismatch', async () => {
    await expectDomainError(
      uploadImage(storage, draft({ mime: 'image/jpeg' })), // png bytes
      'INVALID',
    );
  });

  it('rejects types outside the whitelist, whatever they claim', async () => {
    await expectDomainError(
      uploadImage(storage, draft({ mime: 'image/gif', data: GIF })),
      'INVALID',
    );
    await expectDomainError(
      uploadImage(storage, draft({ mime: 'image/svg+xml', data: Buffer.from('<svg/>') })),
      'INVALID',
    );
  });

  it('enforces the per-kind size cap', async () => {
    const limits = { sizeCaps: { cms: 100, member: 50, listing: 80 } };
    await uploadImage(storage, draft({ data: png(100) }), limits);
    await expectDomainError(
      uploadImage(storage, draft({ data: png(101) }), limits),
      'LIMIT_BREACHED',
    );
    await expectDomainError(
      uploadImage(
        storage,
        draft({ ownerKind: 'member', ownerId: 'm1', data: png(60) }),
        limits,
      ),
      'LIMIT_BREACHED',
    );
  });

  it('setMemberPhoto replaces the previous photo (#14 phase 2: exactly one)', async () => {
    const { setMemberPhoto, deleteMemberPhoto } = await import('../../src/services/images.js');
    const member = await storage.createMember({ groupId: group.id, displayName: 'Alice' });
    const first = await setMemberPhoto(storage, member.id, 'image/png', png(50));
    const second = await setMemberPhoto(storage, member.id, 'image/png', png(60));
    expect(second.id).not.toBe(first.id);

    const photos = await storage.listImages(group.id, {
      ownerKind: 'member', ownerId: member.id,
    });
    expect(photos.map((p) => p.id)).toEqual([second.id]); // the old one is gone
    await expect(storage.getImage(first.id)).rejects.toThrow();

    await deleteMemberPhoto(storage, member.id);
    expect(await storage.listImages(group.id, { ownerKind: 'member', ownerId: member.id }))
      .toEqual([]);
  });

  describe('listing photos (#14 phase 3)', () => {
    async function makeListing() {
      const { addListingPhoto } = await import('../../src/services/images.js');
      const member = await storage.createMember({ groupId: group.id, displayName: 'Alice' });
      await storage.setMemberStatus(member.id, 'active');
      const category = await storage.createCategory({ groupId: group.id, name: 'Food' });
      const listing = await storage.createListing({
        groupId: group.id, memberId: member.id, type: 'offer',
        title: 'Veg box', description: 'Weekly', categoryId: category.id,
      });
      return { addListingPhoto, member, listing };
    }

    it('the listing owner attaches photos, capped at five', async () => {
      const { addListingPhoto, member, listing } = await makeListing();
      for (let i = 0; i < 5; i += 1) {
        await addListingPhoto(storage, listing.id, member.id, 'image/png', png(50 + i));
      }
      const photos = await storage.listImages(group.id, {
        ownerKind: 'listing', ownerId: listing.id,
      });
      expect(photos).toHaveLength(5);
      await expectDomainError(
        addListingPhoto(storage, listing.id, member.id, 'image/png', png()),
        'LIMIT_BREACHED',
      );
    });

    it('only the owner may attach or remove', async () => {
      const { addListingPhoto, listing } = await makeListing();
      const { removeListingPhoto } = await import('../../src/services/images.js');
      const other = await storage.createMember({ groupId: group.id, displayName: 'Bob' });
      await expectDomainError(
        addListingPhoto(storage, listing.id, other.id, 'image/png', png()),
        'NOT_AUTHORISED',
      );
      const owner = (await storage.listListings(group.id, {}))[0]!.memberId;
      const photo = await addListingPhoto(storage, listing.id, owner, 'image/png', png());
      await expectDomainError(
        removeListingPhoto(storage, listing.id, photo.id, other.id),
        'NOT_AUTHORISED',
      );
      await removeListingPhoto(storage, listing.id, photo.id, owner);
      expect(await storage.listImages(group.id, { ownerKind: 'listing', ownerId: listing.id }))
        .toEqual([]);
    });
  });

  describe('brand images (#15): group skinning slots', () => {
    it('setBrandImage keeps exactly one image per slot, replace-on-upload', async () => {
      const { setBrandImage, brandingFor } = await import('../../src/services/images.js');
      const logo = await setBrandImage(storage, group.id, 'logo', 'image/png', png(50), 'admin');
      expect(logo.ownerKind).toBe('brand');
      const header = await setBrandImage(
        storage, group.id, 'header', 'image/png', png(60), 'admin',
      );
      const replaced = await setBrandImage(
        storage, group.id, 'logo', 'image/png', png(70), 'admin',
      );
      expect(replaced.id).not.toBe(logo.id);
      await expect(storage.getImage(logo.id)).rejects.toThrow(); // the old logo is gone
      expect(await brandingFor(storage, group.id)).toEqual({
        logoImageId: replaced.id,
        headerImageId: header.id,
      });
    });

    it('deleteBrandImage clears the slot; a no-op when empty', async () => {
      const { setBrandImage, deleteBrandImage, brandingFor } =
        await import('../../src/services/images.js');
      const logo = await setBrandImage(storage, group.id, 'logo', 'image/png', png(), 'admin');
      await deleteBrandImage(storage, group.id, 'logo');
      expect(await storage.getImage(logo.id).catch(() => undefined)).toBeUndefined();
      expect(await brandingFor(storage, group.id)).toEqual({});
      await deleteBrandImage(storage, group.id, 'logo'); // still empty, still fine
    });

    it('enforces the brand size cap via sizeCaps.brand', async () => {
      const { setBrandImage } = await import('../../src/services/images.js');
      const limits = { sizeCaps: { cms: 100, member: 50, listing: 80, brand: 90 } };
      await setBrandImage(storage, group.id, 'logo', 'image/png', png(90), 'admin', limits);
      await expectDomainError(
        setBrandImage(storage, group.id, 'header', 'image/png', png(91), 'admin', limits),
        'LIMIT_BREACHED',
      );
    });
  });

  it('enforces the group quota across all images', async () => {
    const limits = { groupQuota: 250 };
    await uploadImage(storage, draft({ data: png(100) }), limits);
    await uploadImage(storage, draft({ data: png(100) }), limits);
    await expectDomainError(
      uploadImage(storage, draft({ data: png(100) }), limits),
      'LIMIT_BREACHED',
    );
  });
});

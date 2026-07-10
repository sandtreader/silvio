// Category deletion (todo: Marketplace — the missing half of category
// admin). A category with listings must say where they go; children block
// deletion outright.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Category, Group, Listing, Member } from '../../src/types.js';

describe('DELETE /admin/categories/:id', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let food: Category;
  let garden: Category;
  let listing: Listing;
  let adminCookie: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const user = await register(storage, {
      email: 'alice@example.com', password: 'password-1',
    });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice',
      email: 'alice@example.com', userId: user.id,
    });
    const alice: Member = await approve(storage, applied.member.id);
    await storage.updateMember(alice.id, { role: 'admin' });
    food = await storage.createCategory({ groupId: group.id, name: 'Food' });
    garden = await storage.createCategory({ groupId: group.id, name: 'Garden' });
    listing = await postListing(storage, alice.id, {
      type: 'offer', categoryId: food.id, title: 'Veg box', description: 'Weekly',
    });
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'password-1', groupId: group.id,
    });
    adminCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function remove(id: string, query = '') {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/admin/categories/${id}${query}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
  }

  it('an empty category deletes cleanly', async () => {
    expect((await remove(garden.id)).statusCode).toBe(200);
    const categories = await storage.listCategories(group.id);
    expect(categories.map((c) => c.name)).toEqual(['Food']);
  });

  it('a category with listings needs moveTo, and recategorises them', async () => {
    expect((await remove(food.id)).statusCode).toBe(422);

    const res = await remove(food.id, `?moveTo=${garden.id}`);
    expect(res.statusCode).toBe(200);
    expect((await storage.getListing(listing.id)).categoryId).toBe(garden.id);
    expect((await storage.listCategories(group.id)).map((c) => c.name)).toEqual(['Garden']);
  });

  it('children block deletion; foreign moveTo is refused; audited', async () => {
    const child = await storage.createCategory({
      groupId: group.id, name: 'Preserves', parentId: food.id,
    });
    expect((await remove(food.id, `?moveTo=${garden.id}`)).statusCode).toBe(422);

    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const foreign = await storage.createCategory({ groupId: other.id, name: 'Elsewhere' });
    expect((await remove(child.id, `?moveTo=${foreign.id}`)).statusCode).toBe(404);

    expect((await remove(child.id)).statusCode).toBe(200);
    expect((await storage.listAuditEvents(group.id, { action: 'category.delete' })).total)
      .toBe(1);
  });
});

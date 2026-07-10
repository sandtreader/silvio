// Offers & wants digest (#17): a scheduler sweep sends each member (per
// their digestFrequency) the listings created since the start of the
// previous period — one digest per member per period, however often the
// tick runs, via the standard email dedup keys.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sweepDigests } from '../../src/services/digest.js';
import { tick } from '../../src/services/scheduler.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Category, EmailEvent, Group, Member } from '../../src/types.js';

const DAY = 86_400_000;

describe('offers & wants digest (#17)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let alice: Member;
  let bob: Member;
  let category: Category;
  const t0 = new Date().toISOString();

  function later(days: number): string {
    return new Date(Date.parse(t0) + days * DAY).toISOString();
  }

  async function member(name: string): Promise<Member> {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: name, personName: name,
      email: `${name.toLowerCase()}@example.com`,
    });
    return approve(storage, member.id);
  }

  async function digests(): Promise<EmailEvent[]> {
    return (await storage.pendingEmails(100)).filter((e) => e.kind === 'digest');
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'CamLETS' });
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await member('Alice');
    bob = await member('Bob');
    category = await storage.createCategory({ groupId: group.id, name: 'Food' });
  });

  afterEach(() => {
    storage.close();
  });

  it('members default to a weekly digest', () => {
    expect(alice.digestFrequency).toBe('weekly');
  });

  it('sends the period’s new offers and wants to every weekly member', async () => {
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly veg',
    });
    await postListing(storage, bob.id, {
      type: 'want', categoryId: category.id, title: 'Bike repair', description: 'Fix my brakes',
    });
    const report = await sweepDigests(storage, group.id, t0);
    expect(report.sent).toBe(2); // one per member person with an email

    const events = await digests();
    expect(events.map((e) => e.toEmail).sort())
      .toEqual(['alice@example.com', 'bob@example.com']);
    expect(events[0]!.body).toContain('Veg box');
    expect(events[0]!.body).toContain('Bike repair');
  });

  it('is idempotent within a period and sends afresh in the next one', async () => {
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly veg',
    });
    await sweepDigests(storage, group.id, t0);
    const again = await sweepDigests(storage, group.id, t0);
    expect(again.sent).toBe(0);
    expect(await digests()).toHaveLength(2);

    // A week on: a fresh period, and the listing posted since still lands
    // inside "since the start of the previous period".
    await postListing(storage, bob.id, {
      type: 'want', categoryId: category.id, title: 'Ladder loan', description: 'One weekend',
    });
    const nextWeek = await sweepDigests(storage, group.id, later(7));
    expect(nextWeek.sent).toBe(2);
    const events = await digests();
    expect(events.some((e) => e.body.includes('Ladder loan'))).toBe(true);
  });

  it('members set to none get nothing; monthly members dedup by month', async () => {
    await storage.updateMember(alice.id, { digestFrequency: 'none' });
    await storage.updateMember(bob.id, { digestFrequency: 'monthly' });
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly veg',
    });
    const report = await sweepDigests(storage, group.id, t0);
    expect(report.sent).toBe(1);
    expect((await digests())[0]!.toEmail).toBe('bob@example.com');
    expect((await sweepDigests(storage, group.id, t0)).sent).toBe(0);
  });

  it('sends nothing when the period brought no listings', async () => {
    expect((await sweepDigests(storage, group.id, t0)).sent).toBe(0);
    expect(await digests()).toEqual([]);

    // Stale listings do not resurface: three weeks on, the old listing is
    // outside every window.
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly veg',
    });
    await sweepDigests(storage, group.id, t0);
    expect((await sweepDigests(storage, group.id, later(21))).sent).toBe(0);
  });

  it('rides the scheduler tick', async () => {
    await postListing(storage, alice.id, {
      type: 'offer', categoryId: category.id, title: 'Veg box', description: 'Weekly veg',
    });
    const report = await tick(storage, t0, { alert: () => {} });
    expect(report.digestsSent).toBe(2);
  });
});

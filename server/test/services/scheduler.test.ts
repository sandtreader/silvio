// Scheduler tick (decisions #1, #5): one idempotent pass over all groups —
// demurrage runs on/after each currency's posting day, pending-transaction
// sweep, listing expiry sweep. Wall-clock wiring stays thin; tick() is the
// tested unit and takes `now` explicitly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from '../../src/services/scheduler.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Account, Currency, Group, Member } from '../../src/types.js';

const BANDS = [
  { fromAmount: 0, ratePpmPerMonth: 0 },
  { fromAmount: 10_000, ratePpmPerMonth: 10_000 }, // 1%/mo above 100.00
];

describe('scheduler tick', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let community: Account;
  let alice: Member;
  let bob: Member;

  async function member(name: string): Promise<Member> {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: name, personName: name,
    });
    return approve(storage, member.id);
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2, demurrageDay: 5,
    });
    await storage.setDemurrageBands(cams.id, BANDS);
    community = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'community',
    });
    alice = await member('Alice');
    bob = await member('Bob');
    // bob pays alice 600.00: alice 60000 (chargeable), bob -60000
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: bob.id, payeeMemberId: alice.id,
      currencyId: cams.id, amount: 60_000, actorPersonId: 'p', channel: 'web',
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('runs demurrage on or after the posting day, never before', async () => {
    const before = await tick(storage, '2026-07-04T09:00:00.000Z');
    expect(before.demurrageRuns).toBe(0);
    expect(await storage.balance(community.id)).toBe(0);

    const onDay = await tick(storage, '2026-07-05T09:00:00.000Z');
    expect(onDay.demurrageRuns).toBe(1);
    expect(await storage.balance(community.id)).toBe(500); // (60000-10000) @ 1%
  });

  it('catches up if the server was down on the posting day', async () => {
    const late = await tick(storage, '2026-07-19T09:00:00.000Z');
    expect(late.demurrageRuns).toBe(1);
  });

  it('is idempotent within a month and runs again the next month', async () => {
    await tick(storage, '2026-07-05T09:00:00.000Z');
    const again = await tick(storage, '2026-07-20T09:00:00.000Z');
    expect(again.demurrageRuns).toBe(0); // period complete
    expect(await storage.balance(community.id)).toBe(500);

    const nextMonth = await tick(storage, '2026-08-05T09:00:00.000Z');
    expect(nextMonth.demurrageRuns).toBe(1);
    // alice now 59500: (59500-10000) @ 1% = 495
    expect(await storage.balance(community.id)).toBe(995);
  });

  it('skips currencies with no demurrage day', async () => {
    const palms = await storage.createCurrency({
      groupId: group.id, code: 'PLM', name: 'Palms', scale: 2,
    });
    await storage.setDemurrageBands(palms.id, BANDS);
    await storage.createAccount({ groupId: group.id, currencyId: palms.id, type: 'community' });
    const report = await tick(storage, '2026-07-05T09:00:00.000Z');
    expect(report.demurrageRuns).toBe(1); // cams only
  });

  it('sweeps due pending transactions and expired listings', async () => {
    await storage.updateMember(bob.id, { confirmIncoming: true });
    const past = new Date(Date.now() - 1000).toISOString();
    await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 100, actorPersonId: 'p', channel: 'web',
      expiresAt: past,
    });
    const cat = await storage.createCategory({ groupId: group.id, name: 'Misc' });
    await postListing(storage, alice.id, {
      type: 'offer', title: 'Old', description: 'x', categoryId: cat.id, expiresAt: past,
    });

    const report = await tick(storage, new Date().toISOString());
    expect(report.autoAccepted).toBe(1);
    expect(report.listingsExpired).toBe(1);
  });

  it('processes every group', async () => {
    const g2 = await storage.createGroup({ slug: 'g2', name: 'G2' });
    const c2 = await storage.createCurrency({
      groupId: g2.id, code: 'CAM', name: 'Cams', scale: 2, demurrageDay: 1,
    });
    await storage.setDemurrageBands(c2.id, BANDS);
    await storage.createAccount({ groupId: g2.id, currencyId: c2.id, type: 'community' });

    const report = await tick(storage, '2026-07-05T09:00:00.000Z');
    expect(report.demurrageRuns).toBe(2); // one per group's currency
  });

  // Decision #6: verification runs on every tick and failures are loud —
  // there is no silent option.
  describe('journal verification', () => {
    it('verifies every group and reports a healthy journal quietly', async () => {
      const alert = vi.fn();
      const report = await tick(storage, '2026-07-04T09:00:00.000Z', { alert });
      expect(report.verifyFailures).toBe(0);
      expect(alert).not.toHaveBeenCalled();
    });

    it('alerts loudly when verification fails', async () => {
      const alert = vi.fn();
      vi.spyOn(storage, 'verify').mockResolvedValue({
        ok: false,
        errors: ['hash chain broken at seq 3'],
      });
      const report = await tick(storage, '2026-07-04T09:00:00.000Z', { alert });
      expect(report.verifyFailures).toBe(1);
      expect(alert).toHaveBeenCalledOnce();
      const message = alert.mock.calls[0]![0] as string;
      expect(message).toContain('g'); // the group slug
      expect(message).toContain('hash chain broken at seq 3');
    });

    it('alerts if verification itself throws, and the tick still completes', async () => {
      const alert = vi.fn();
      vi.spyOn(storage, 'verify').mockRejectedValue(new Error('disk on fire'));
      const report = await tick(storage, '2026-07-05T09:00:00.000Z', { alert });
      expect(report.verifyFailures).toBe(1);
      expect(alert).toHaveBeenCalledOnce();
      expect(alert.mock.calls[0]![0] as string).toContain('disk on fire');
      expect(report.demurrageRuns).toBe(1); // the rest of the tick still ran
    });
  });
});

// Group settings (data-model: group.settings json): per-group knobs that
// were hard-coded constants — pending auto-accept days, invoice expiry
// days, and the digest default applied to new members. Absent keys mean
// the platform defaults, so a group row never needs migrating.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { effectiveSettings } from '../../src/services/settings.js';
import { sendPayment, requestPayment } from '../../src/services/trading.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

const DAY = 86_400_000;

describe('group settings', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let bob: Member;

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
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams' });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await member('Alice');
    bob = await member('Bob');
    // Bob confirms incoming payments, so payments to him are held (#5).
    await storage.updateMember(bob.id, { confirmIncoming: true });
  });

  afterEach(() => {
    storage.close();
  });

  it('effectiveSettings fills the platform defaults for absent keys', async () => {
    expect(effectiveSettings(group)).toEqual({
      autoAcceptDays: 14,
      invoiceExpiryDays: 30,
      digestDefault: 'weekly',
      listingMaxAgeDays: 180,
    });
    const updated = await storage.updateGroup(group.id, {
      settings: { autoAcceptDays: 3 },
    });
    expect(effectiveSettings(updated)).toEqual({
      autoAcceptDays: 3,
      invoiceExpiryDays: 30,
      digestDefault: 'weekly',
      listingMaxAgeDays: 180,
    });
  });

  it('held payments expire per the group’s autoAcceptDays', async () => {
    await storage.updateGroup(group.id, { settings: { autoAcceptDays: 2 } });
    const persons = await storage.personsForMember(alice.id);
    const tx = await sendPayment(storage, {
      groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
      currencyId: cams.id, amount: 100, actorPersonId: persons[0]!.id, channel: 'web',
    });
    expect(tx.state).toBe('pending');
    const horizon = Date.parse(tx.expiresAt!) - Date.now();
    expect(horizon).toBeGreaterThan(1.9 * DAY);
    expect(horizon).toBeLessThan(2.1 * DAY);
  });

  it('invoices expire per the group’s invoiceExpiryDays', async () => {
    await storage.updateGroup(group.id, { settings: { invoiceExpiryDays: 5 } });
    const persons = await storage.personsForMember(alice.id);
    const tx = await requestPayment(storage, {
      groupId: group.id, payeeMemberId: alice.id, payerMemberId: bob.id,
      currencyId: cams.id, amount: 100, actorPersonId: persons[0]!.id, channel: 'web',
    });
    const horizon = Date.parse(tx.expiresAt!) - Date.now();
    expect(horizon).toBeGreaterThan(4.9 * DAY);
    expect(horizon).toBeLessThan(5.1 * DAY);
  });

  it('new members inherit the group’s digestDefault', async () => {
    await storage.updateGroup(group.id, { settings: { digestDefault: 'none' } });
    const carol = await member('Carol');
    expect(carol.digestFrequency).toBe('none');
    // Existing members are untouched — the default applies at join time.
    expect((await storage.getMember(alice.id)).digestFrequency).toBe('weekly');
  });
});

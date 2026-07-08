// Membership lifecycle (decision #7): applied -> active <-> away/suspended
// -> closed, with leaver settlement to the community account.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  apply,
  approve,
  reject,
  setAway,
  suspend,
  reinstate,
  leave,
} from '../../src/services/membership.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Account, Currency, Group } from '../../src/types.js';

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code,
    `expected DomainError ${code}`,
  );
}

describe('membership service (#7)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let community: Account;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    community = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'community',
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('apply creates an applied member with a primary person', async () => {
    const { member, person } = await apply(storage, {
      groupId: group.id,
      displayName: 'Alice',
      personName: 'Alice Smith',
      email: 'alice@example.com',
    });
    expect(member.status).toBe('applied');
    expect(member.memberNo).toBe(1);
    expect(person.isPrimary).toBe(true);
    expect(person.email).toBe('alice@example.com');
    const second = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'Bob Jones',
    });
    expect(second.member.memberNo).toBe(2);
  });

  it('approve activates and opens an account per group currency', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice Smith',
    });
    const active = await approve(storage, member.id);
    expect(active.status).toBe('active');
    expect(active.approvedAt).toBeDefined();
    const accounts = await storage.accountsForMember(member.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.currencyId).toBe(cams.id);
    expect(accounts[0]!.type).toBe('member');
  });

  it('approve is only valid from applied', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    await approve(storage, member.id);
    await expectDomainError(approve(storage, member.id), 'WRONG_STATE');
  });

  it('reject closes an applied member', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    const rejected = await reject(storage, member.id);
    expect(rejected.status).toBe('closed');
    await expectDomainError(approve(storage, member.id), 'WRONG_STATE');
  });

  it('away is a member-reversible toggle on an active member', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    await approve(storage, member.id);
    expect((await setAway(storage, member.id, true)).status).toBe('away');
    expect((await setAway(storage, member.id, false)).status).toBe('active');
    await expectDomainError(setAway(storage, member.id, false), 'WRONG_STATE'); // not away
  });

  it('suspend and reinstate are admin actions on active/away members', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    await approve(storage, member.id);
    expect((await suspend(storage, member.id)).status).toBe('suspended');
    await expectDomainError(setAway(storage, member.id, true), 'WRONG_STATE');
    expect((await reinstate(storage, member.id)).status).toBe('active');
  });

  it('leave settles a positive residual to the community account and closes', async () => {
    const { member: alice } = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'A',
    });
    const { member: bob } = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'B',
    });
    await approve(storage, alice.id);
    await approve(storage, bob.id);
    const aliceAcc = (await storage.accountsForMember(alice.id))[0]!;
    const bobAcc = (await storage.accountsForMember(bob.id))[0]!;
    await storage.post({
      groupId: group.id, type: 'trade', state: 'committed', createdBy: 'p', channel: 'web',
      entries: [
        { accountId: bobAcc.id, amount: -300 },
        { accountId: aliceAcc.id, amount: 300 },
      ],
    });

    const closed = await leave(storage, alice.id);
    expect(closed.status).toBe('closed');
    expect(await storage.balance(aliceAcc.id)).toBe(0);
    expect(await storage.balance(community.id)).toBe(300);
    expect(await storage.accountsForMember(alice.id)).toHaveLength(0); // accounts closed
    expect((await storage.verify(group.id)).ok).toBe(true);
    // settlement is an ordinary typed transaction on the statement
    const lines = await storage.statement(aliceAcc.id);
    expect(lines.at(-1)!.type).toBe('settlement');
  });

  it('leave absorbs a negative residual into the community account', async () => {
    const { member: alice } = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'A',
    });
    const { member: bob } = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'B',
    });
    await approve(storage, alice.id);
    await approve(storage, bob.id);
    const aliceAcc = (await storage.accountsForMember(alice.id))[0]!;
    const bobAcc = (await storage.accountsForMember(bob.id))[0]!;
    await storage.post({
      groupId: group.id, type: 'trade', state: 'committed', createdBy: 'p', channel: 'web',
      entries: [
        { accountId: aliceAcc.id, amount: -450 },
        { accountId: bobAcc.id, amount: 450 },
      ],
    });

    await leave(storage, alice.id);
    expect(await storage.balance(aliceAcc.id)).toBe(0);
    expect(await storage.balance(community.id)).toBe(-450); // visible absorption (#7)
    expect((await storage.verify(group.id)).ok).toBe(true);
  });

  it('leave with a zero balance posts no settlement', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    await approve(storage, member.id);
    const acc = (await storage.accountsForMember(member.id))[0]!;
    await leave(storage, member.id);
    expect(await storage.statement(acc.id)).toHaveLength(0);
  });

  it('leave works from suspended (removal flow shares settlement, #7)', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    await approve(storage, member.id);
    await suspend(storage, member.id);
    expect((await leave(storage, member.id)).status).toBe('closed');
  });

  it('leave is invalid for applied or already-closed members', async () => {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'A', personName: 'A',
    });
    await expectDomainError(leave(storage, member.id), 'WRONG_STATE');
    await approve(storage, member.id);
    await leave(storage, member.id);
    await expectDomainError(leave(storage, member.id), 'WRONG_STATE');
  });
});

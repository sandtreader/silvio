// Membership lifecycle (decision #7):
// applied -> active <-> away, active|away <-> suspended, and leave/remove
// settling any residual balance to the community account before closing.

import type { Storage } from '../storage/interface.js';
import type { Id, Member, MemberStatus, MemberType, Person } from '../types.js';
import { DomainError } from './errors.js';

export interface ApplyInput {
  groupId: Id;
  displayName: string;
  personName: string;
  email?: string;
  userId?: Id; // links the primary person to a login (decision #2)
  type?: MemberType;
}

async function memberInState(
  storage: Storage,
  memberId: Id,
  allowed: MemberStatus[],
  action: string,
): Promise<Member> {
  const member = await storage.getMember(memberId);
  if (!allowed.includes(member.status)) {
    throw new DomainError(
      'WRONG_STATE',
      `cannot ${action}: member ${member.displayName} is ${member.status}, not ${allowed.join('/')}`,
    );
  }
  return member;
}

/** Create an applied member with its primary person (decision #7). */
export async function apply(
  storage: Storage,
  input: ApplyInput,
): Promise<{ member: Member; person: Person }> {
  const memberInput: { groupId: Id; displayName: string; type?: MemberType } = {
    groupId: input.groupId,
    displayName: input.displayName,
  };
  if (input.type !== undefined) memberInput.type = input.type;
  const member = await storage.createMember(memberInput);
  const personInput: {
    memberId: Id;
    userId?: Id;
    name: string;
    email?: string;
    isPrimary?: boolean;
  } = {
    memberId: member.id,
    name: input.personName,
    isPrimary: true,
  };
  if (input.userId !== undefined) personInput.userId = input.userId;
  if (input.email !== undefined) personInput.email = input.email;
  const person = await storage.createPerson(personInput);
  return { member, person };
}

/** applied -> active; open a member account per group currency. */
export async function approve(storage: Storage, memberId: Id): Promise<Member> {
  await memberInState(storage, memberId, ['applied'], 'approve');
  const member = await storage.setMemberStatus(memberId, 'active');
  for (const currency of await storage.listCurrencies(member.groupId)) {
    await storage.ensureMemberAccount(memberId, currency.id);
  }
  return member;
}

/** applied -> closed. */
export async function reject(storage: Storage, memberId: Id): Promise<Member> {
  await memberInState(storage, memberId, ['applied'], 'reject');
  return storage.setMemberStatus(memberId, 'closed');
}

/** Member-reversible active <-> away toggle. */
export async function setAway(storage: Storage, memberId: Id, away: boolean): Promise<Member> {
  if (away) {
    await memberInState(storage, memberId, ['active'], 'go away');
    return storage.setMemberStatus(memberId, 'away');
  }
  await memberInState(storage, memberId, ['away'], 'return from away');
  return storage.setMemberStatus(memberId, 'active');
}

/** Admin action: active|away -> suspended. */
export async function suspend(storage: Storage, memberId: Id): Promise<Member> {
  await memberInState(storage, memberId, ['active', 'away'], 'suspend');
  return storage.setMemberStatus(memberId, 'suspended');
}

/** Admin action: suspended -> active. */
export async function reinstate(storage: Storage, memberId: Id): Promise<Member> {
  await memberInState(storage, memberId, ['suspended'], 'reinstate');
  return storage.setMemberStatus(memberId, 'active');
}

/**
 * Leave/remove (decision #7): settle each account's residual balance —
 * either sign — to the community account as an ordinary 'settlement'
 * transaction, close the accounts, close the membership.
 */
export async function leave(storage: Storage, memberId: Id): Promise<Member> {
  const member = await memberInState(
    storage,
    memberId,
    ['active', 'away', 'suspended'],
    'leave',
  );
  for (const account of await storage.accountsForMember(memberId)) {
    const balance = await storage.balance(account.id);
    if (balance !== 0) {
      const accounts = await storage.listAccounts(member.groupId, account.currencyId);
      const community = accounts.find((candidate) => candidate.type === 'community');
      if (!community) {
        throw new DomainError(
          'NOT_FOUND',
          `no community account for currency ${account.currencyId} to settle to`,
        );
      }
      await storage.post({
        groupId: member.groupId,
        type: 'settlement',
        state: 'committed',
        createdBy: 'system',
        channel: 'system',
        description: `Leaver settlement for ${member.displayName}`,
        entries: [
          { accountId: account.id, amount: -balance },
          { accountId: community.id, amount: balance },
        ],
      });
    }
    await storage.closeAccount(account.id);
  }
  return storage.setMemberStatus(memberId, 'closed');
}

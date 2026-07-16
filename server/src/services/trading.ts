// Trading service (decision #5): two-phase payments and invoices over the
// ledger, with credit-control authorisation at commit time (decision #3).

import type { Actor, Storage } from '../storage/interface.js';
import type { Account, Channel, Id, Member, NewTransaction, Transaction } from '../types.js';
import { DomainError } from './errors.js';
import { notifyTrade } from './notifications.js';
import { effectiveSettings, type EffectiveGroupSettings } from './settings.js';

export interface SendPaymentInput {
  groupId: Id;
  payerMemberId: Id;
  payeeMemberId: Id;
  currencyId: Id;
  amount: number;
  description?: string;
  actorPersonId: Id;
  channel: Channel;
  apiTokenId?: Id; // set when an API token initiated this (decision #9)
  expiresAt?: string;
  // Scanned payment request (#22): the payee minted the request, so their
  // confirm-incoming preference must not hold the payment — the initiator
  // consented by initiating (#5's invoice semantics).
  bypassHold?: boolean;
  // Passed through to storage.post (#22): a replay returns the original.
  idempotencyKey?: string;
}

export interface RequestPaymentInput {
  groupId: Id;
  payeeMemberId: Id;
  payerMemberId: Id;
  currencyId: Id;
  amount: number;
  description?: string;
  actorPersonId: Id;
  channel: Channel;
  apiTokenId?: Id; // set when an API token initiated this (decision #9)
  expiresAt?: string;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** The group's effective settings (no getGroup; cf. notifications.ts). */
async function groupSettings(storage: Storage, groupId: Id): Promise<EffectiveGroupSettings> {
  const group = (await storage.listGroups()).find((candidate) => candidate.id === groupId);
  if (!group) throw new DomainError('NOT_FOUND', `group ${groupId} not found`);
  return effectiveSettings(group);
}

function validateAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new DomainError('INVALID', `amount must be a positive integer, got ${amount}`);
  }
}

/** Trading requires status active or away (decision #7). */
async function tradeableMember(storage: Storage, memberId: Id): Promise<Member> {
  const member = await storage.getMember(memberId);
  if (member.status === 'suspended') {
    throw new DomainError('SUSPENDED', `${member.displayName} is suspended and cannot trade`);
  }
  if (member.status !== 'active' && member.status !== 'away') {
    throw new DomainError(
      'WRONG_STATE',
      `${member.displayName} is ${member.status} and cannot trade`,
    );
  }
  return member;
}

/** Manual restriction blocks outward payments only (decision #3). */
async function checkRestriction(storage: Storage, payerMemberId: Id): Promise<void> {
  const restriction = await storage.activeRestriction(payerMemberId);
  if (restriction) {
    throw new DomainError(
      'RESTRICTED',
      `outward payments are blocked by an admin restriction: ${restriction.reason}`,
    );
  }
}

/** Hard limits and payment caps deny at commit; soft thresholds never block (#3, #26). */
async function checkBlockingPolicies(
  storage: Storage,
  groupId: Id,
  currencyId: Id,
  payerAccountId: Id,
  payeeAccountId: Id,
  amount: number,
): Promise<void> {
  for (const policy of await storage.creditPolicies(groupId, currencyId)) {
    if (policy.type === 'max_payment') {
      const { maxAmount } = policy.config;
      if (maxAmount !== undefined && amount > maxAmount) {
        throw new DomainError(
          'LIMIT_BREACHED',
          `this payment of ${amount} exceeds the group's per-transaction cap of ${maxAmount}`,
        );
      }
      continue;
    }
    if (policy.type !== 'hard_limit') continue;
    const { minBalance, maxBalance } = policy.config;
    if (minBalance !== undefined) {
      const resulting = (await storage.balance(payerAccountId)) - amount;
      if (resulting < minBalance) {
        throw new DomainError(
          'LIMIT_BREACHED',
          `this payment would take the payer's balance to ${resulting}, below the group limit of ${minBalance}`,
        );
      }
    }
    if (maxBalance !== undefined) {
      const resulting = (await storage.balance(payeeAccountId)) + amount;
      if (resulting > maxBalance) {
        throw new DomainError(
          'LIMIT_BREACHED',
          `this payment would take the payee's balance to ${resulting}, above the group limit of ${maxBalance}`,
        );
      }
    }
  }
}

/** Payer restriction + hard limits, as run at commit time (decision #5). */
async function authoriseCommit(
  storage: Storage,
  groupId: Id,
  payerAccount: Account,
  payeeAccount: Account,
  amount: number,
): Promise<void> {
  if (payerAccount.memberId !== undefined) {
    await checkRestriction(storage, payerAccount.memberId);
  }
  await checkBlockingPolicies(
    storage,
    groupId,
    payerAccount.currencyId,
    payerAccount.id,
    payeeAccount.id,
    amount,
  );
}

async function accountById(storage: Storage, _groupId: Id, accountId: Id): Promise<Account> {
  try {
    return await storage.getAccount(accountId);
  } catch {
    throw new DomainError('NOT_FOUND', `account ${accountId} not found`);
  }
}

interface PendingLegs {
  tx: Transaction;
  payerAccount: Account;
  payeeAccount: Account;
  amount: number;
}

async function pendingLegs(storage: Storage, txId: Id): Promise<PendingLegs> {
  const tx = await storage.getTransaction(txId);
  if (tx.state !== 'pending') {
    throw new DomainError('WRONG_STATE', `transaction is ${tx.state}, not pending`);
  }
  const payerEntry = tx.entries.find((entry) => entry.amount < 0);
  const payeeEntry = tx.entries.find((entry) => entry.amount > 0);
  if (!payerEntry || !payeeEntry) {
    throw new DomainError('INVALID', 'transaction has no payer/payee legs');
  }
  return {
    tx,
    payerAccount: await accountById(storage, tx.groupId, payerEntry.accountId),
    payeeAccount: await accountById(storage, tx.groupId, payeeEntry.accountId),
    amount: payeeEntry.amount,
  };
}

function systemActor(): Actor {
  return { personId: 'system' };
}

/**
 * Payer-initiated push (decision #5): commits immediately unless the payee
 * has opted into confirm-incoming, in which case it holds pending with an
 * auto-accept deadline.
 */
export async function sendPayment(storage: Storage, input: SendPaymentInput): Promise<Transaction> {
  validateAmount(input.amount);
  if (input.payerMemberId === input.payeeMemberId) {
    throw new DomainError('INVALID', 'payer and payee must differ');
  }
  await tradeableMember(storage, input.payerMemberId);
  const payee = await tradeableMember(storage, input.payeeMemberId);
  await checkRestriction(storage, input.payerMemberId);

  const payerAccount = await storage.ensureMemberAccount(input.payerMemberId, input.currencyId);
  const payeeAccount = await storage.ensureMemberAccount(input.payeeMemberId, input.currencyId);

  const hold = payee.confirmIncoming && input.bypassHold !== true;
  if (!hold) {
    await checkBlockingPolicies(
      storage,
      input.groupId,
      input.currencyId,
      payerAccount.id,
      payeeAccount.id,
      input.amount,
    );
  }

  const tx: NewTransaction = {
    groupId: input.groupId,
    type: 'trade',
    flow: 'payment',
    state: hold ? 'pending' : 'committed',
    createdBy: input.actorPersonId,
    channel: input.channel,
    entries: [
      { accountId: payerAccount.id, amount: -input.amount },
      { accountId: payeeAccount.id, amount: input.amount },
    ],
  };
  if (input.description !== undefined) tx.description = input.description;
  if (input.apiTokenId !== undefined) tx.apiTokenId = input.apiTokenId;
  if (hold) {
    // Only fetch the group when the default horizon is actually needed.
    tx.expiresAt =
      input.expiresAt ??
      daysFromNow((await groupSettings(storage, input.groupId)).autoAcceptDays);
  }
  const posted = await storage.post(tx, input.idempotencyKey);
  // Tell the payee (#5): a hold awaits their confirmation, a commit landed.
  await notifyTrade(storage, posted, hold ? 'payment_held' : 'payment_received');
  return posted;
}

/**
 * Payee-initiated invoice (decision #5): always pending until the payer
 * accepts — the payer authorises at commit, so no restriction check here.
 */
export async function requestPayment(
  storage: Storage,
  input: RequestPaymentInput,
): Promise<Transaction> {
  validateAmount(input.amount);
  if (input.payerMemberId === input.payeeMemberId) {
    throw new DomainError('INVALID', 'payer and payee must differ');
  }
  await tradeableMember(storage, input.payerMemberId);
  await tradeableMember(storage, input.payeeMemberId);

  const payerAccount = await storage.ensureMemberAccount(input.payerMemberId, input.currencyId);
  const payeeAccount = await storage.ensureMemberAccount(input.payeeMemberId, input.currencyId);

  const tx: NewTransaction = {
    groupId: input.groupId,
    type: 'trade',
    flow: 'invoice',
    state: 'pending',
    createdBy: input.actorPersonId,
    channel: input.channel,
    // The group is only fetched when the default horizon is actually needed.
    expiresAt:
      input.expiresAt ??
      daysFromNow((await groupSettings(storage, input.groupId)).invoiceExpiryDays),
    entries: [
      { accountId: payerAccount.id, amount: -input.amount },
      { accountId: payeeAccount.id, amount: input.amount },
    ],
  };
  if (input.description !== undefined) tx.description = input.description;
  if (input.apiTokenId !== undefined) tx.apiTokenId = input.apiTokenId;
  const posted = await storage.post(tx);
  await notifyTrade(storage, posted, 'invoice_received');
  return posted;
}

/** The responding party: the payee of a held payment, the payer of an invoice. */
function responderAccount(legs: PendingLegs): Account {
  return legs.tx.flow === 'invoice' ? legs.payerAccount : legs.payeeAccount;
}

/**
 * Accept a pending transaction (decision #5). Credit-control authorisation
 * runs here, at commit time; on denial the transaction stays pending.
 */
export async function accept(storage: Storage, txId: Id, actorMemberId: Id): Promise<Transaction> {
  const legs = await pendingLegs(storage, txId);
  if (responderAccount(legs).memberId !== actorMemberId) {
    throw new DomainError(
      'NOT_AUTHORISED',
      legs.tx.flow === 'invoice'
        ? 'only the payer may accept an invoice'
        : 'only the payee may accept a held payment',
    );
  }
  await authoriseCommit(storage, legs.tx.groupId, legs.payerAccount, legs.payeeAccount, legs.amount);
  const committed = await storage.transition(txId, 'committed', { personId: actorMemberId });
  await notifyTrade(storage, committed, 'payment_accepted'); // to the initiator
  return committed;
}

/** Decline a pending transaction — same role rules as accept. */
export async function decline(storage: Storage, txId: Id, actorMemberId: Id): Promise<Transaction> {
  const legs = await pendingLegs(storage, txId);
  if (responderAccount(legs).memberId !== actorMemberId) {
    throw new DomainError(
      'NOT_AUTHORISED',
      legs.tx.flow === 'invoice'
        ? 'only the payer may decline an invoice'
        : 'only the payee may decline a held payment',
    );
  }
  const declined = await storage.transition(txId, 'declined', { personId: actorMemberId });
  await notifyTrade(storage, declined, 'payment_declined'); // to the initiator
  return declined;
}

/** Only the initiator may cancel: the payer of a payment, the payee of an invoice. */
export async function cancel(storage: Storage, txId: Id, actorMemberId: Id): Promise<Transaction> {
  const legs = await pendingLegs(storage, txId);
  const initiator = legs.tx.flow === 'invoice' ? legs.payeeAccount : legs.payerAccount;
  if (initiator.memberId !== actorMemberId) {
    throw new DomainError('NOT_AUTHORISED', 'only the initiator may cancel');
  }
  return storage.transition(txId, 'cancelled', { personId: actorMemberId });
}

/** Human reversal description (#25): the reversed transaction's seq, its
 * parties resolved to display names (counterparty ref or account type where
 * memberless), and its description elided to 40 characters. */
async function reversalDescription(storage: Storage, tx: Transaction): Promise<string> {
  async function label(accountId: Id): Promise<string> {
    const account = await storage.getAccount(accountId);
    if (account.memberId !== undefined) {
      return (await storage.getMember(account.memberId)).displayName;
    }
    return account.counterpartyRef ?? account.type;
  }
  const from = await Promise.all(
    tx.entries.filter((e) => e.amount < 0).map((e) => label(e.accountId)),
  );
  const to = await Promise.all(
    tx.entries.filter((e) => e.amount > 0).map((e) => label(e.accountId)),
  );
  const base = `Reversal of #${tx.seq}: ${from.join(', ')} → ${to.join(', ')}`;
  if (tx.description === undefined) return base;
  const elided =
    tx.description.length <= 40 ? tx.description : `${tx.description.slice(0, 39)}…`;
  return `${base}, ${elided}`;
}

/**
 * Admin reversal (decisions #5, #6): post a committed compensating
 * transaction linked via reversesId, with every leg negated. Any committed
 * transaction — reversals included — is reversible exactly once (#25); the
 * guard is a data lookup, never a state on the reversed row.
 */
export async function reverse(storage: Storage, txId: Id, actorPersonId: Id): Promise<Transaction> {
  const tx = await storage.getTransaction(txId);
  if (tx.state !== 'committed') {
    throw new DomainError('WRONG_STATE', `transaction is ${tx.state}, not committed`);
  }
  if ((await storage.reversalsOf([txId]))[txId] !== undefined) {
    throw new DomainError('WRONG_STATE', 'transaction has already been reversed');
  }
  return storage.post({
    groupId: tx.groupId,
    type: 'reversal',
    state: 'committed',
    createdBy: actorPersonId,
    channel: 'admin',
    description: await reversalDescription(storage, tx),
    reversesId: txId,
    entries: tx.entries.map((entry) => ({
      accountId: entry.accountId,
      amount: -entry.amount,
    })),
  });
}

export interface SweepResult {
  autoAccepted: number;
  expired: number;
}

/**
 * Expiry sweep (decision #5): due held payments auto-accept (running the
 * same commit-time authorisation — a denial expires them instead); due
 * invoices expire.
 */
export async function sweepDue(storage: Storage, groupId: Id, asOf: string): Promise<SweepResult> {
  let autoAccepted = 0;
  let expired = 0;
  for (const tx of await storage.pendingDue(groupId, asOf)) {
    if (tx.flow === 'payment') {
      try {
        const legs = await pendingLegs(storage, tx.id);
        await authoriseCommit(
          storage,
          tx.groupId,
          legs.payerAccount,
          legs.payeeAccount,
          legs.amount,
        );
        const committed = await storage.transition(tx.id, 'committed', systemActor());
        // Both parties learn of the auto-accept; dedup keys make the
        // repeated sweep re-notification a no-op (#5).
        await notifyTrade(storage, committed, 'payment_auto_accepted', asOf);
        autoAccepted += 1;
        continue;
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        // Denied at commit: the hold lapses instead of committing.
      }
    }
    const lapsed = await storage.transition(tx.id, 'expired', systemActor());
    if (lapsed.flow === 'invoice') {
      await notifyTrade(storage, lapsed, 'invoice_expired', asOf); // to the initiator
    }
    expired += 1;
  }
  return { autoAccepted, expired };
}

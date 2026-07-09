// Transactional notifications (decisions #3, #5, #7; todo: Email &
// notifications). Domain events are composed into email_events here — one
// per person on the affected membership with an email address — and queued
// via storage; delivery is email.ts's job. Dedup keys are stable per
// (event, person), so sweeps and retries re-enqueue as silent no-ops.

import type { Storage } from '../storage/interface.js';
import type { Currency, Id, Member, Restriction, Transaction } from '../types.js';

/** Minor units -> human amount at the currency's scale, e.g. 500 -> "5.00 CAM". */
function formatAmount(amount: number, currency: Currency): string {
  return `${(amount / 10 ** currency.scale).toFixed(currency.scale)} ${currency.code}`;
}

/** Enqueue one email per person on the membership with an email; none is a no-op. */
async function enqueueForMember(
  storage: Storage,
  memberId: Id,
  kind: string,
  dedupScope: string,
  subject: string,
  body: string,
  nowIso?: string,
): Promise<void> {
  const member = await storage.getMember(memberId);
  for (const person of await storage.personsForMember(memberId)) {
    if (person.email === undefined) continue;
    await storage.enqueueEmail({
      groupId: member.groupId,
      personId: person.id,
      kind,
      dedupKey: `${kind}:${dedupScope}:${person.id}`,
      toEmail: person.email,
      subject,
      body,
      createdAt: nowIso ?? new Date().toISOString(),
    });
  }
}

/** Membership approval (#7): welcome the new member by group name. */
export async function notifyWelcome(storage: Storage, member: Member): Promise<void> {
  const group = (await storage.listGroups()).find((candidate) => candidate.id === member.groupId);
  const groupName = group?.name ?? 'the group';
  await enqueueForMember(
    storage,
    member.id,
    'welcome',
    member.id,
    `Welcome to ${groupName}`,
    `Hello ${member.displayName},\n\nYour membership of ${groupName} has been approved. ` +
      'You can now trade and browse the marketplace.',
  );
}

export type TradeNotificationKind =
  | 'invoice_received'
  | 'payment_held'
  | 'payment_received'
  | 'payment_accepted'
  | 'payment_declined'
  | 'payment_auto_accepted'
  | 'invoice_expired';

/**
 * Trading events (#5). Everything is derived from the transaction: the
 * negative leg's account is the payer, the positive leg's the payee, and the
 * recipients follow from the kind (the initiator of an invoice is the payee,
 * of a payment the payer). Dedup keys scope to the transaction id, so the
 * repeated sweeps in scheduler.ts never double-send.
 */
export async function notifyTrade(
  storage: Storage,
  tx: Transaction,
  kind: TradeNotificationKind,
  nowIso?: string,
): Promise<void> {
  const payerEntry = tx.entries.find((entry) => entry.amount < 0);
  const payeeEntry = tx.entries.find((entry) => entry.amount > 0);
  if (!payerEntry || !payeeEntry) return;
  const payerAccount = await storage.getAccount(payerEntry.accountId);
  const payeeAccount = await storage.getAccount(payeeEntry.accountId);
  const payerId = payerAccount.memberId;
  const payeeId = payeeAccount.memberId;

  const currency = (await storage.listCurrencies(tx.groupId)).find(
    (candidate) => candidate.id === payeeAccount.currencyId,
  );
  const amount = currency
    ? formatAmount(payeeEntry.amount, currency)
    : String(payeeEntry.amount);
  const payerName = payerId ? (await storage.getMember(payerId)).displayName : 'someone';
  const payeeName = payeeId ? (await storage.getMember(payeeId)).displayName : 'someone';
  const description = tx.description !== undefined ? `\n\nDescription: ${tx.description}` : '';

  const initiatorId = tx.flow === 'invoice' ? payeeId : payerId;
  const messages: Record<
    TradeNotificationKind,
    { to: Id | undefined; subject: string; body: string }[]
  > = {
    invoice_received: [
      {
        to: payerId,
        subject: `Invoice from ${payeeName}: ${amount}`,
        body: `${payeeName} has requested a payment of ${amount} from you. Accept or decline it in your account.${description}`,
      },
    ],
    payment_held: [
      {
        to: payeeId,
        subject: `Payment of ${amount} awaiting your confirmation`,
        body: `${payerName} sent you ${amount}. It is held until you accept or decline it.${description}`,
      },
    ],
    payment_received: [
      {
        to: payeeId,
        subject: `Payment received: ${amount}`,
        body: `${payerName} paid you ${amount}.${description}`,
      },
    ],
    payment_accepted: [
      {
        to: initiatorId,
        subject: `Your ${tx.flow === 'invoice' ? 'invoice' : 'payment'} of ${amount} was accepted`,
        body: `The ${tx.flow === 'invoice' ? 'invoice' : 'payment'} of ${amount} between ${payerName} and ${payeeName} has been accepted and committed.${description}`,
      },
    ],
    payment_declined: [
      {
        to: initiatorId,
        subject: `Your ${tx.flow === 'invoice' ? 'invoice' : 'payment'} of ${amount} was declined`,
        body: `The ${tx.flow === 'invoice' ? 'invoice' : 'payment'} of ${amount} between ${payerName} and ${payeeName} has been declined.${description}`,
      },
    ],
    payment_auto_accepted: [
      {
        to: payerId,
        subject: `Payment of ${amount} auto-accepted`,
        body: `Your held payment of ${amount} to ${payeeName} reached its deadline and was automatically accepted.${description}`,
      },
      {
        to: payeeId,
        subject: `Payment of ${amount} auto-accepted`,
        body: `The held payment of ${amount} from ${payerName} reached its deadline and was automatically accepted.${description}`,
      },
    ],
    invoice_expired: [
      {
        to: payeeId,
        subject: `Invoice expired: ${amount}`,
        body: `Your invoice of ${amount} to ${payerName} expired without a response.${description}`,
      },
    ],
  };

  for (const message of messages[kind]) {
    if (message.to === undefined) continue; // non-member account (community etc.)
    await enqueueForMember(storage, message.to, kind, tx.id, message.subject, message.body, nowIso);
  }
}

/** Restriction imposed (#3): tell the member, with the admin's reason. */
export async function notifyRestrictionImposed(
  storage: Storage,
  restriction: Restriction,
): Promise<void> {
  await enqueueForMember(
    storage,
    restriction.memberId,
    'restriction_imposed',
    restriction.id,
    'A restriction has been placed on your account',
    `An administrator has restricted outward payments from your account.\n\nReason: ${restriction.reason}`,
  );
}

/**
 * Restriction lifted (#3). Only the member id is known here (the restriction
 * row is already lifted), so the dedup scope includes the timestamp: lifting
 * is a one-shot admin action, not a re-running sweep, and a later re-lift is
 * a genuinely new event.
 */
export async function notifyRestrictionLifted(storage: Storage, memberId: Id): Promise<void> {
  const nowIso = new Date().toISOString();
  await enqueueForMember(
    storage,
    memberId,
    'restriction_lifted',
    `${memberId}:${nowIso}`,
    'The restriction on your account has been lifted',
    'An administrator has lifted the restriction on your account. Outward payments are enabled again.',
    nowIso,
  );
}

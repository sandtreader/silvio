// Transactional notifications (decisions #3, #5, #7, #16). Domain events are
// composed into email_events here — one per person on the affected membership
// with an email address — and queued via storage; delivery is email.ts's job.
// Dedup keys are stable per (event, person), so sweeps and retries re-enqueue
// as silent no-ops. Texts come from the group's effective templates (#16),
// with the group sender snapshotted onto each event at enqueue time.

import type { Storage } from '../storage/interface.js';
import type { Currency, Id, Listing, Member, Restriction, Transaction } from '../types.js';
import {
  effectiveEmailTemplate,
  renderTemplate,
  type EmailTemplateKind,
} from './emailtemplates.js';

/** Minor units -> human amount at the currency's scale, e.g. 500 -> "5.00 CAM". */
export function formatAmount(amount: number, currency: Currency): string {
  return `${(amount / 10 ** currency.scale).toFixed(currency.scale)} ${currency.code}`;
}

/**
 * Enqueue one email per person on the membership with an email; none is a
 * no-op. Resolves the group's effective template for templateKind (#16) and
 * substitutes vars plus {{memberName}}/{{groupName}} for the recipient.
 * Returns how many emails were newly enqueued (dedup no-ops don't count).
 */
async function enqueueForMember(
  storage: Storage,
  memberId: Id,
  kind: string,
  templateKind: EmailTemplateKind,
  dedupScope: string,
  vars: Record<string, string>,
  nowIso?: string,
): Promise<number> {
  const member = await storage.getMember(memberId);
  const group = (await storage.listGroups()).find((candidate) => candidate.id === member.groupId);
  const template = await effectiveEmailTemplate(storage, member.groupId, templateKind);
  const allVars = {
    ...vars,
    memberName: member.displayName,
    groupName: group?.name ?? 'the group',
  };
  const subject = renderTemplate(template.subject, allVars);
  const body = renderTemplate(template.body, allVars).trimEnd();
  let enqueued = 0;
  for (const person of await storage.personsForMember(memberId)) {
    if (person.email === undefined) continue;
    const event = await storage.enqueueEmail({
      groupId: member.groupId,
      personId: person.id,
      kind,
      dedupKey: `${kind}:${dedupScope}:${person.id}`,
      toEmail: person.email,
      subject,
      body,
      // Snapshot the group sender (#16); absent falls back at delivery.
      ...(group?.emailFrom !== undefined ? { fromEmail: group.emailFrom } : {}),
      createdAt: nowIso ?? new Date().toISOString(),
    });
    if (event !== undefined) enqueued += 1;
  }
  return enqueued;
}

/**
 * Listing expiry warning (#18): dedup scopes to (listing, expiry date), so
 * each expiry date warns once and a renewal re-arms the warning. Returns
 * true when anything was newly enqueued — the sweep counts listings warned.
 */
export async function notifyListingExpiryWarning(
  storage: Storage,
  listing: Listing,
  nowIso: string,
): Promise<boolean> {
  const enqueued = await enqueueForMember(
    storage,
    listing.memberId,
    'listing_expiry_warning',
    'listing_expiry_warning',
    `${listing.id}:${listing.expiresAt}`,
    { listingTitle: listing.title, expiresOn: (listing.expiresAt ?? '').slice(0, 10) },
    nowIso,
  );
  return enqueued > 0;
}

/** Membership approval (#7): welcome the new member by group name. */
export async function notifyWelcome(storage: Storage, member: Member): Promise<void> {
  await enqueueForMember(storage, member.id, 'welcome', 'welcome', member.id, {});
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
 * repeated sweeps in scheduler.ts never double-send. The event kind stays the
 * TradeNotificationKind; only the template kinds split payment_auto_accepted
 * into recipient-specific texts (#16).
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
  const vars: Record<string, string> = {
    amount: currency ? formatAmount(payeeEntry.amount, currency) : String(payeeEntry.amount),
    payerName: payerId ? (await storage.getMember(payerId)).displayName : 'someone',
    payeeName: payeeId ? (await storage.getMember(payeeId)).displayName : 'someone',
    flowName: tx.flow === 'invoice' ? 'invoice' : 'payment',
    descriptionLine: tx.description !== undefined ? `Description: ${tx.description}` : '',
  };

  const initiatorId = tx.flow === 'invoice' ? payeeId : payerId;
  const messages: Record<
    TradeNotificationKind,
    { to: Id | undefined; template: EmailTemplateKind }[]
  > = {
    invoice_received: [{ to: payerId, template: 'invoice_received' }],
    payment_held: [{ to: payeeId, template: 'payment_held' }],
    payment_received: [{ to: payeeId, template: 'payment_received' }],
    payment_accepted: [{ to: initiatorId, template: 'payment_accepted' }],
    payment_declined: [{ to: initiatorId, template: 'payment_declined' }],
    payment_auto_accepted: [
      { to: payerId, template: 'payment_auto_accepted_payer' },
      { to: payeeId, template: 'payment_auto_accepted_payee' },
    ],
    invoice_expired: [{ to: payeeId, template: 'invoice_expired' }],
  };

  for (const message of messages[kind]) {
    if (message.to === undefined) continue; // non-member account (community etc.)
    await enqueueForMember(storage, message.to, kind, message.template, tx.id, vars, nowIso);
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
    'restriction_imposed',
    restriction.id,
    { reason: restriction.reason },
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
    'restriction_lifted',
    `${memberId}:${nowIso}`,
    {},
    nowIso,
  );
}

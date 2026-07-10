// Email templates (#16): every notification kind has a built-in default;
// groups override per kind (storage email_templates). Bodies are markdown
// with {{placeholder}} substitution — dumb string replacement here,
// markdown-it's escaping applies at delivery, so member-supplied values
// can't inject markup. Unknown placeholders pass through literally.

import type { Storage } from '../storage/interface.js';
import type { Id } from '../types.js';

export const EMAIL_TEMPLATE_KINDS = [
  'welcome',
  'invoice_received',
  'payment_held',
  'payment_received',
  'payment_accepted',
  'payment_declined',
  'payment_auto_accepted_payer',
  'payment_auto_accepted_payee',
  'invoice_expired',
  'restriction_imposed',
  'restriction_lifted',
  'password_reset',
  'email_verify',
  'digest',
] as const;

export type EmailTemplateKind = (typeof EMAIL_TEMPLATE_KINDS)[number];

// The defaults, verbatim from the pre-#16 hard-coded strings. Placeholders:
// {{memberName}} (the recipient), {{groupName}}, {{amount}} (pre-formatted,
// e.g. "5.00 CAM"), {{payerName}}, {{payeeName}}, {{flowName}} ("invoice" |
// "payment"), {{reason}}, and {{descriptionLine}} — '' or "Description: …",
// pre-composed so bodies can end with it and rendered bodies are trimmed.
// payment_auto_accepted splits into _payer/_payee: two recipients, two texts.
// password_reset/email_verify (data-model §1) get {{resetUrl}}/{{verifyUrl}}
// but no {{memberName}}: they are sent by the recovery service, not
// enqueueForMember, and the recipient may not be a member.
export const DEFAULT_EMAIL_TEMPLATES: Record<
  EmailTemplateKind,
  { subject: string; body: string }
> = {
  welcome: {
    subject: 'Welcome to {{groupName}}',
    body:
      'Hello {{memberName}},\n\nYour membership of {{groupName}} has been approved. ' +
      'You can now trade and browse the marketplace.',
  },
  invoice_received: {
    subject: 'Invoice from {{payeeName}}: {{amount}}',
    body:
      '{{payeeName}} has requested a payment of {{amount}} from you. ' +
      'Accept or decline it in your account.\n\n{{descriptionLine}}',
  },
  payment_held: {
    subject: 'Payment of {{amount}} awaiting your confirmation',
    body:
      '{{payerName}} sent you {{amount}}. It is held until you accept or ' +
      'decline it.\n\n{{descriptionLine}}',
  },
  payment_received: {
    subject: 'Payment received: {{amount}}',
    body: '{{payerName}} paid you {{amount}}.\n\n{{descriptionLine}}',
  },
  payment_accepted: {
    subject: 'Your {{flowName}} of {{amount}} was accepted',
    body:
      'The {{flowName}} of {{amount}} between {{payerName}} and {{payeeName}} ' +
      'has been accepted and committed.\n\n{{descriptionLine}}',
  },
  payment_declined: {
    subject: 'Your {{flowName}} of {{amount}} was declined',
    body:
      'The {{flowName}} of {{amount}} between {{payerName}} and {{payeeName}} ' +
      'has been declined.\n\n{{descriptionLine}}',
  },
  payment_auto_accepted_payer: {
    subject: 'Payment of {{amount}} auto-accepted',
    body:
      'Your held payment of {{amount}} to {{payeeName}} reached its deadline ' +
      'and was automatically accepted.\n\n{{descriptionLine}}',
  },
  payment_auto_accepted_payee: {
    subject: 'Payment of {{amount}} auto-accepted',
    body:
      'The held payment of {{amount}} from {{payerName}} reached its deadline ' +
      'and was automatically accepted.\n\n{{descriptionLine}}',
  },
  invoice_expired: {
    subject: 'Invoice expired: {{amount}}',
    body:
      'Your invoice of {{amount}} to {{payerName}} expired without a ' +
      'response.\n\n{{descriptionLine}}',
  },
  restriction_imposed: {
    subject: 'A restriction has been placed on your account',
    body:
      'An administrator has restricted outward payments from your account.' +
      '\n\nReason: {{reason}}',
  },
  restriction_lifted: {
    subject: 'The restriction on your account has been lifted',
    body:
      'An administrator has lifted the restriction on your account. ' +
      'Outward payments are enabled again.',
  },
  password_reset: {
    subject: 'Reset your {{groupName}} password',
    body:
      'Someone asked to reset the password for your {{groupName}} account. ' +
      'Follow this link to choose a new one — it works once, within one ' +
      'hour:\n\n{{resetUrl}}\n\nIf this was not you, ignore this email; ' +
      'your password is unchanged.',
  },
  email_verify: {
    subject: 'Verify your email address for {{groupName}}',
    body:
      'Welcome to {{groupName}}. Please confirm this email address by ' +
      'following the link:\n\n{{verifyUrl}}',
  },
  // Offers & wants digest (#17): {{listings}} is the pre-rendered markdown
  // section the digest service supplies.
  digest: {
    subject: 'New offers and wants at {{groupName}}',
    body:
      'Hello {{memberName}},\n\nHere is what is new at {{groupName}}:\n\n' +
      '{{listings}}',
  },
};

/** Replace every {{key}} occurrence; unknown placeholders pass through. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key]! : match,
  );
}

/** The group's override for the kind, or the built-in default. */
export async function effectiveEmailTemplate(
  storage: Storage,
  groupId: Id,
  kind: EmailTemplateKind,
): Promise<{ subject: string; body: string }> {
  const override = await storage.getEmailTemplate(groupId, kind);
  return override
    ? { subject: override.subject, body: override.body }
    : DEFAULT_EMAIL_TEMPLATES[kind];
}

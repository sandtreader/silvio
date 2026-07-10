// Group settings (data-model: group.settings json): per-group knobs with
// platform defaults for absent keys, so a group row never needs migrating.
// Consumers (trading.ts, membership.ts) only ever see the effective values.

import type { DigestFrequency, Group, Transparency } from '../types.js';

// Platform defaults (decisions #5, #17, #18, #19).
const DEFAULT_AUTO_ACCEPT_DAYS = 14;
const DEFAULT_INVOICE_EXPIRY_DAYS = 30;
const DEFAULT_DIGEST: DigestFrequency = 'weekly';
const DEFAULT_LISTING_MAX_AGE_DAYS = 180;
const DEFAULT_TRANSPARENCY: Transparency = 'none';

/** GroupSettings with every key resolved. */
export interface EffectiveGroupSettings {
  autoAcceptDays: number;
  invoiceExpiryDays: number;
  digestDefault: DigestFrequency;
  listingMaxAgeDays: number;
  transparency: Transparency;
}

export function effectiveSettings(group: Group): EffectiveGroupSettings {
  return {
    autoAcceptDays: group.settings?.autoAcceptDays ?? DEFAULT_AUTO_ACCEPT_DAYS,
    invoiceExpiryDays: group.settings?.invoiceExpiryDays ?? DEFAULT_INVOICE_EXPIRY_DAYS,
    digestDefault: group.settings?.digestDefault ?? DEFAULT_DIGEST,
    listingMaxAgeDays: group.settings?.listingMaxAgeDays ?? DEFAULT_LISTING_MAX_AGE_DAYS,
    transparency: group.settings?.transparency ?? DEFAULT_TRANSPARENCY,
  };
}

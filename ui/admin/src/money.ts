// Money display for the admin app. The per-currency scale comes from the
// group's currency list (see currencies.ts); pages look it up for the
// currency they are editing.

import type { CurrencyOption } from './currencies';

// Used only before the (async) currency list has loaded: nothing to read a
// scale from yet, so assume the common 2 decimal places.
export const FALLBACK_SCALE = 2;

/** Display scale of the selected currency, or the fallback while loading. */
export function scaleFor(currencies: CurrencyOption[], currencyId: string): number {
  return currencies.find((c) => c.id === currencyId)?.scale ?? FALLBACK_SCALE;
}

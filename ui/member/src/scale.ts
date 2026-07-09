// Per-currency display scale. GET /me account summaries carry the currency's
// scale, so anywhere an account is in scope we format/parse at account.scale.
import type { AccountSummary } from '@silvio/ui-shared';

// Used only where no account is loaded yet (e.g. a scanned QR payload shown
// before /me resolves): assume the common 2 decimal places.
export const FALLBACK_SCALE = 2;

/** Display scale of an account, or the fallback when none is loaded. */
export function scaleOf(account: AccountSummary | undefined): number {
  return account?.scale ?? FALLBACK_SCALE;
}

/** Display scale for a currency, looked up in the /me account summaries. */
export function scaleForCurrency(
  accounts: AccountSummary[] | undefined,
  currencyId: string | undefined,
): number {
  return scaleOf(accounts?.find((account) => account.currencyId === currencyId));
}

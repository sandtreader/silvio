// Per-currency display scale. GET /me account summaries carry the currency's
// scale, so anywhere an account is in scope we format/parse at account.scale.
// Where no account exists (logged-out marketplace browsing), the public
// GET /currencies list carries the real scale instead.
import type { AccountSummary, Currency } from '@silvio/ui-shared';

// Used only where neither an account nor a currency list is loaded yet
// (e.g. a scanned QR payload shown before /me resolves, or while
// GET /currencies is still in flight): assume the common 2 decimal places.
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

/**
 * Display scale for a currency, looked up in a GET /currencies list, or
 * undefined while the list has not loaded or the currency is unknown.
 */
export function scaleFromCurrencies(
  currencies: Currency[] | undefined,
  currencyId: string | undefined,
): number | undefined {
  return currencies?.find((currency) => currency.id === currencyId)?.scale;
}

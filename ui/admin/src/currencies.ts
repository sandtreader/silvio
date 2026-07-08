// Currency choices for the admin pages. LIMITATION: there is no public
// currencies endpoint on the server yet, so the only visible source is the
// logged-in admin's own accounts (GET /me) — one account per currency the
// admin uses. A group currency the admin holds no account in will not appear
// here; a GET /currencies (or admin equivalent) is a known server gap.

import { useEffect, useState } from 'react';
import type { AdminApi } from './api';

export interface CurrencyOption {
  id: string;
  code: string;
}

/** Load the currencies visible via the admin's own accounts. */
export function useCurrencies(api: AdminApi): CurrencyOption[] {
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.me().then((me) => {
      if (cancelled || me === undefined) return;
      const seen = new Set<string>();
      const options: CurrencyOption[] = [];
      for (const account of me.accounts) {
        if (seen.has(account.currencyId)) continue;
        seen.add(account.currencyId);
        options.push({ id: account.currencyId, code: account.currencyCode });
      }
      setCurrencies(options);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);
  return currencies;
}

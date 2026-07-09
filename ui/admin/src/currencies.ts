// Currency choices for the admin pages, loaded from the group's public
// GET /currencies endpoint.

import { useEffect, useState } from 'react';
import type { AdminApi } from './api';

export interface CurrencyOption {
  id: string;
  code: string;
  /** Display scale (decimal places). */
  scale: number;
}

/** Load the group's currencies. */
export function useCurrencies(api: AdminApi): CurrencyOption[] {
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.currencies().then((list) => {
      if (cancelled || list === undefined) return;
      setCurrencies(list.map(({ id, code, scale }) => ({ id, code, scale })));
    });
    return () => {
      cancelled = true;
    };
  }, [api]);
  return currencies;
}

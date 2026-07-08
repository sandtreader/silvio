// Wrap every ApiClient call: ApiError -> snackbar, result -> value or
// undefined. Keeps page code free of try/catch boilerplate.
import { ApiError } from '@silvio/ui-shared';
import { useCallback, useMemo, useState } from 'react';
import { useFeedback } from './feedback';

export interface Api {
  /** Run an API call; on ApiError show a snackbar and return undefined. */
  run<T>(call: () => Promise<T>): Promise<T | undefined>;
  /** true while a call started by this hook instance is in flight. */
  busy: boolean;
}

export function useApi(): Api {
  const feedback = useFeedback();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        feedback.show(error.message, 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [feedback],
  );

  return useMemo(() => ({ run, busy }), [run, busy]);
}

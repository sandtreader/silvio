// Session state: /me on mount; 401/NOT_AUTHORISED (or any failure) means
// logged out. Pages call refresh() after login or profile changes.
import { ApiError } from '@silvio/ui-shared';
import type { Me } from '@silvio/ui-shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useClient } from './client';

export interface Auth {
  /** null while logged out. */
  me: Me | null;
  /** true only while the initial /me call is in flight. */
  loading: boolean;
  refresh(): Promise<void>;
  /** Forget the session locally (after logout). */
  clear(): void;
}

const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error('useAuth must be used inside AuthProvider');
  return auth;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await client.me());
    } catch (error) {
      // 401/NOT_AUTHORISED is the normal logged-out signal; any other
      // failure also leaves us logged out and the page surfaces the error.
      if (!(error instanceof ApiError)) throw error;
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clear = useCallback(() => setMe(null), []);
  const value = useMemo(
    () => ({ me, loading, refresh, clear }),
    [me, loading, refresh, clear],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

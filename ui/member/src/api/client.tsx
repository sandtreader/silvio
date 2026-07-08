// The ApiClient reaches components via context so tests can inject a fake.
// The default is the real same-origin client (dev: Vite proxies /api).
import { ApiClient } from '@silvio/ui-shared';
import { createContext, useContext } from 'react';

const ClientContext = createContext<ApiClient>(new ApiClient({ baseUrl: '' }));

export const ClientProvider = ClientContext.Provider;

export function useClient(): ApiClient {
  return useContext(ClientContext);
}

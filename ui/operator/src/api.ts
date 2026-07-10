// Thin API layer for the operator pages: every call is wrapped so that
// failures surface as a snackbar notification and a `undefined` result —
// never an exception thrown into Rafiki components (same idiom as the admin
// app, decision #11). Pages take an OperatorApi so tests can inject a mock.

import {
  ApiClient,
  ApiError,
  type CreateGroupInput,
  type Currency,
  type Group,
  type Member,
  type OperatorGroup,
  type OperatorGroupPatch,
} from '@silvio/ui-shared';

/** Same-origin client: dev goes via the Vite proxy, production is served
 *  by the Silvio server itself (decision #21). */
export const client = new ApiClient({ baseUrl: '' });

// --- Error notification -------------------------------------------------------

type ErrorListener = (message: string) => void;
let errorListener: ErrorListener | undefined;

/** Register the (single) snackbar host; returns an unsubscribe function. */
export function onApiError(listener: ErrorListener): () => void {
  errorListener = listener;
  return () => {
    if (errorListener === listener) errorListener = undefined;
  };
}

/** Await an API call; on failure notify the listener and return undefined. */
async function call<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (cause) {
    const message =
      cause instanceof ApiError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    errorListener?.(message);
    return undefined;
  }
}

// --- The page-facing API -------------------------------------------------------

/** Everything the operator pages need; resolves undefined on failure. */
export interface OperatorApi {
  operatorGroups(): Promise<OperatorGroup[] | undefined>;
  provisionGroup(
    input: CreateGroupInput,
  ): Promise<{ group: Group; currency: Currency; admin?: Member } | undefined>;
  patchOperatorGroup(
    id: string,
    patch: OperatorGroupPatch,
  ): Promise<OperatorGroup | undefined>;
  addGroupDomain(id: string, hostname: string): Promise<boolean>;
  removeGroupDomain(id: string, hostname: string): Promise<boolean>;
}

/** The real implementation over the shared ApiClient. */
export const api: OperatorApi = {
  operatorGroups: async () => (await call(client.operatorGroups()))?.groups,
  provisionGroup: async (input) => call(client.provisionGroup(input)),
  patchOperatorGroup: async (id, patch) =>
    (await call(client.patchOperatorGroup(id, patch)))?.group,
  addGroupDomain: async (id, hostname) =>
    (await call(client.addGroupDomain(id, hostname)))?.ok ?? false,
  removeGroupDomain: async (id, hostname) =>
    (await call(client.removeGroupDomain(id, hostname)))?.ok ?? false,
};

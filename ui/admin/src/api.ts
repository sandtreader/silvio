// Thin API layer for the admin pages: every call is wrapped so that failures
// surface as a snackbar notification and a `undefined` result — never an
// exception thrown into Rafiki components (decision #11). Pages take an
// AdminApi so tests can inject a mock.

import {
  ApiClient,
  ApiError,
  type Category,
  type CreditPolicyConfig,
  type DemurrageBand,
  type Flag,
  type Me,
  type Member,
  type MemberAction,
  type MemberRole,
  type MemberStatus,
  type Policy,
  type PolicyInput,
  type Restriction,
  type Transaction,
} from '@silvio/ui-shared';

/** Same-origin client: dev goes via the Vite proxy, production is served
 *  by the Silvio server itself (decision #11). */
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

/** Everything the admin pages need; resolves undefined on failure. */
export interface AdminApi {
  me(): Promise<Me | undefined>;
  adminMembers(status?: MemberStatus): Promise<Member[] | undefined>;
  adminMemberAction(id: string, action: MemberAction): Promise<Member | undefined>;
  adminSetRole(id: string, role: MemberRole): Promise<Member | undefined>;
  adminRestrict(memberId: string, reason: string): Promise<Restriction | undefined>;
  adminUnrestrict(memberId: string): Promise<boolean>;
  adminPolicies(): Promise<Policy[] | undefined>;
  adminAddPolicy(input: PolicyInput): Promise<Policy | undefined>;
  adminPatchPolicy(
    id: string,
    patch: { enabled?: boolean; config?: CreditPolicyConfig },
  ): Promise<Policy | undefined>;
  adminGetBands(currencyId: string): Promise<DemurrageBand[] | undefined>;
  adminSetBands(
    currencyId: string,
    bands: DemurrageBand[],
  ): Promise<DemurrageBand[] | undefined>;
  adminFlags(currencyId: string): Promise<Flag[] | undefined>;
  adminReverse(id: string): Promise<Transaction | undefined>;
  categories(): Promise<Category[] | undefined>;
  adminCreateCategory(input: {
    name: string;
    parentId?: string;
  }): Promise<Category | undefined>;
  adminUpdateCategory(
    id: string,
    patch: { name?: string; parentId?: string },
  ): Promise<Category | undefined>;
}

/** The real implementation over the shared ApiClient. */
export const api: AdminApi = {
  me: async () => call(client.me()),
  adminMembers: async (status) =>
    (await call(client.adminMembers(status)))?.members,
  adminMemberAction: async (id, action) =>
    (await call(client.adminMemberAction(id, action)))?.member,
  adminSetRole: async (id, role) => (await call(client.adminSetRole(id, role)))?.member,
  adminRestrict: async (memberId, reason) =>
    (await call(client.adminRestrict(memberId, reason)))?.restriction,
  adminUnrestrict: async (memberId) =>
    (await call(client.adminUnrestrict(memberId)))?.ok ?? false,
  adminPolicies: async () => (await call(client.adminPolicies()))?.policies,
  adminAddPolicy: async (input) => (await call(client.adminAddPolicy(input)))?.policy,
  adminPatchPolicy: async (id, patch) =>
    (await call(client.adminPatchPolicy(id, patch)))?.policy,
  adminGetBands: async (currencyId) =>
    (await call(client.adminGetBands(currencyId)))?.bands,
  adminSetBands: async (currencyId, bands) =>
    (await call(client.adminSetBands(currencyId, bands)))?.bands,
  adminFlags: async (currencyId) => (await call(client.adminFlags(currencyId)))?.flags,
  adminReverse: async (id) => (await call(client.adminReverse(id)))?.transaction,
  categories: async () => (await call(client.categories()))?.categories,
  adminCreateCategory: async (input) =>
    (await call(client.adminCreateCategory(input)))?.category,
  adminUpdateCategory: async (id, patch) =>
    (await call(client.adminUpdateCategory(id, patch)))?.category,
};

// Thin API layer for the admin pages: every call is wrapped so that failures
// surface as a snackbar notification and a `undefined` result — never an
// exception thrown into Rafiki components (decision #11). Pages take an
// AdminApi so tests can inject a mock.

import {
  ApiClient,
  ApiError,
  type AdminAuditEvent,
  type AdminStats,
  type AdminTransaction,
  type AuditFilter,
  type BrandSlot,
  type Category,
  type CreditPolicyConfig,
  type Currency,
  type DemurrageBand,
  type DemurrageRun,
  type EmailTemplate,
  type EmailTemplateKind,
  type Flag,
  type Group,
  type GroupSettings,
  type Image,
  type Me,
  type Member,
  type MemberAction,
  type MemberRole,
  type MemberStatus,
  type NewsInput,
  type NewsItem,
  type Page,
  type PageInput,
  type Policy,
  type PolicyInput,
  type Restriction,
  type ShellInfo,
  type Transaction,
  type TransactionFilter,
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
  /** Public session-aware shell info (#15): group identity for the chrome. */
  shellInfo(): Promise<ShellInfo | undefined>;
  adminMembers(status?: MemberStatus): Promise<Member[] | undefined>;
  adminMemberAction(id: string, action: MemberAction): Promise<Member | undefined>;
  adminSetRole(id: string, role: MemberRole): Promise<Member | undefined>;
  /** Act for a member (#24); the member app then presents as them. */
  actAsMember(id: string): Promise<boolean>;
  adminRestrictions(): Promise<Restriction[] | undefined>;
  adminRestrict(memberId: string, reason: string): Promise<Restriction | undefined>;
  adminUnrestrict(memberId: string): Promise<boolean>;
  adminPolicies(): Promise<Policy[] | undefined>;
  adminAddPolicy(input: PolicyInput): Promise<Policy | undefined>;
  adminPatchPolicy(
    id: string,
    patch: { enabled?: boolean; config?: CreditPolicyConfig },
  ): Promise<Policy | undefined>;
  adminDeletePolicy(id: string): Promise<boolean>;
  adminGetBands(currencyId: string): Promise<DemurrageBand[] | undefined>;
  adminSetBands(
    currencyId: string,
    bands: DemurrageBand[],
  ): Promise<DemurrageBand[] | undefined>;
  /** Demurrage run history, newest first. */
  adminRuns(): Promise<DemurrageRun[] | undefined>;
  adminFlags(currencyId: string): Promise<Flag[] | undefined>;
  adminStats(currencyId: string): Promise<AdminStats | undefined>;
  adminTransactions(
    filter?: TransactionFilter,
  ): Promise<{ transactions: AdminTransaction[]; total: number } | undefined>;
  adminReverse(id: string): Promise<Transaction | undefined>;
  adminAudit(
    filter?: AuditFilter,
  ): Promise<{ events: AdminAuditEvent[]; total: number } | undefined>;
  categories(): Promise<Category[] | undefined>;
  currencies(): Promise<Currency[] | undefined>;
  adminCreateCategory(input: {
    name: string;
    parentId?: string;
  }): Promise<Category | undefined>;
  adminUpdateCategory(
    id: string,
    patch: { name?: string; parentId?: string },
  ): Promise<Category | undefined>;
  /** Delete a category; 'needs-move' means it has listings and wants a moveTo. */
  adminDeleteCategory(
    id: string,
    moveTo?: string,
  ): Promise<{ moved: number } | 'needs-move' | undefined>;
  adminPages(): Promise<Page[] | undefined>;
  adminCreatePage(input: PageInput): Promise<Page | undefined>;
  adminUpdatePage(id: string, patch: Partial<PageInput>): Promise<Page | undefined>;
  adminDeletePage(id: string): Promise<boolean>;
  adminImages(): Promise<Image[] | undefined>;
  adminUploadImage(data: Blob, mime: string): Promise<Image | undefined>;
  adminDeleteImage(id: string): Promise<boolean>;
  adminBrandImages(): Promise<Image[] | undefined>;
  setBrandImage(slot: BrandSlot, data: Blob, mime: string): Promise<Image | undefined>;
  deleteBrandImage(slot: BrandSlot): Promise<boolean>;
  adminNews(): Promise<NewsItem[] | undefined>;
  adminCreateNews(input: NewsInput): Promise<NewsItem | undefined>;
  adminUpdateNews(
    id: string,
    patch: Partial<NewsInput>,
  ): Promise<NewsItem | undefined>;
  adminDeleteNews(id: string): Promise<boolean>;
  adminEmailTemplates(): Promise<EmailTemplate[] | undefined>;
  putEmailTemplate(
    kind: EmailTemplateKind,
    input: { subject: string; body: string },
  ): Promise<EmailTemplate | undefined>;
  deleteEmailTemplate(kind: EmailTemplateKind): Promise<boolean>;
  adminGroup(): Promise<Group | undefined>;
  patchAdminGroup(patch: {
    name?: string;
    emailFrom?: string | null;
    settings?: GroupSettings;
  }): Promise<Group | undefined>;
  /** Broadcast to every active member (#17); resolves the queued count. */
  adminBroadcast(subject: string, body: string): Promise<number | undefined>;
}

/** The real implementation over the shared ApiClient. */
export const api: AdminApi = {
  me: async () => call(client.me()),
  shellInfo: async () => call(client.shellInfo()),
  adminMembers: async (status) =>
    (await call(client.adminMembers(status)))?.members,
  adminMemberAction: async (id, action) =>
    (await call(client.adminMemberAction(id, action)))?.member,
  adminSetRole: async (id, role) => (await call(client.adminSetRole(id, role)))?.member,
  actAsMember: async (id) => (await call(client.actAsMember(id)))?.ok ?? false,
  adminRestrictions: async () =>
    (await call(client.adminRestrictions()))?.restrictions,
  adminRestrict: async (memberId, reason) =>
    (await call(client.adminRestrict(memberId, reason)))?.restriction,
  adminUnrestrict: async (memberId) =>
    (await call(client.adminUnrestrict(memberId)))?.ok ?? false,
  adminPolicies: async () => (await call(client.adminPolicies()))?.policies,
  adminAddPolicy: async (input) => (await call(client.adminAddPolicy(input)))?.policy,
  adminPatchPolicy: async (id, patch) =>
    (await call(client.adminPatchPolicy(id, patch)))?.policy,
  adminDeletePolicy: async (id) =>
    (await call(client.adminDeletePolicy(id)))?.ok ?? false,
  adminGetBands: async (currencyId) =>
    (await call(client.adminGetBands(currencyId)))?.bands,
  adminSetBands: async (currencyId, bands) =>
    (await call(client.adminSetBands(currencyId, bands)))?.bands,
  adminRuns: async () => (await call(client.adminRuns()))?.runs,
  adminFlags: async (currencyId) => (await call(client.adminFlags(currencyId)))?.flags,
  adminStats: async (currencyId) => call(client.adminStats(currencyId)),
  adminTransactions: async (filter) => call(client.adminTransactions(filter)),
  adminReverse: async (id) => (await call(client.adminReverse(id)))?.transaction,
  adminAudit: async (filter) => call(client.adminAudit(filter)),
  categories: async () => (await call(client.categories()))?.categories,
  currencies: async () => (await call(client.currencies()))?.currencies,
  adminCreateCategory: async (input) =>
    (await call(client.adminCreateCategory(input)))?.category,
  adminUpdateCategory: async (id, patch) =>
    (await call(client.adminUpdateCategory(id, patch)))?.category,
  adminDeleteCategory: async (id, moveTo) => {
    try {
      return await client.adminDeleteCategory(id, moveTo);
    } catch (cause) {
      // The listings 422 asks for a moveTo (its message says so); re-prompt
      // instead of snackbaring. Everything else takes the normal path.
      if (
        cause instanceof ApiError &&
        cause.status === 422 &&
        cause.message.includes('moveTo')
      ) {
        return 'needs-move';
      }
      return call(Promise.reject(cause));
    }
  },
  adminPages: async () => (await call(client.adminPages()))?.pages,
  adminCreatePage: async (input) => (await call(client.adminCreatePage(input)))?.page,
  adminUpdatePage: async (id, patch) =>
    (await call(client.adminUpdatePage(id, patch)))?.page,
  adminDeletePage: async (id) => (await call(client.adminDeletePage(id)))?.ok ?? false,
  adminImages: async () => (await call(client.adminImages()))?.images,
  adminUploadImage: async (data, mime) =>
    (await call(client.adminUploadImage(data, mime)))?.image,
  adminDeleteImage: async (id) => (await call(client.adminDeleteImage(id)))?.ok ?? false,
  adminBrandImages: async () => (await call(client.adminBrandImages()))?.images,
  setBrandImage: async (slot, data, mime) =>
    (await call(client.setBrandImage(slot, data, mime)))?.image,
  deleteBrandImage: async (slot) =>
    (await call(client.deleteBrandImage(slot)))?.ok ?? false,
  adminNews: async () => (await call(client.adminNews()))?.news,
  adminCreateNews: async (input) =>
    (await call(client.adminCreateNews(input)))?.newsItem,
  adminUpdateNews: async (id, patch) =>
    (await call(client.adminUpdateNews(id, patch)))?.newsItem,
  adminDeleteNews: async (id) => (await call(client.adminDeleteNews(id)))?.ok ?? false,
  adminEmailTemplates: async () =>
    (await call(client.adminEmailTemplates()))?.templates,
  putEmailTemplate: async (kind, input) =>
    (await call(client.putEmailTemplate(kind, input)))?.template,
  deleteEmailTemplate: async (kind) =>
    (await call(client.deleteEmailTemplate(kind)))?.ok ?? false,
  adminGroup: async () => (await call(client.adminGroup()))?.group,
  patchAdminGroup: async (patch) => (await call(client.patchAdminGroup(patch)))?.group,
  adminBroadcast: async (subject, body) =>
    (await call(client.adminBroadcast(subject, body)))?.queued,
};

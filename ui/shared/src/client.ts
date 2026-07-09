// Typed HTTP client over global fetch for the Silvio REST API, shared by the
// member and admin UIs. Same-origin cookie sessions (credentials: 'include');
// tenancy follows the server (decision #2): hostname mode by default, with
// the /api/v1/g/{slug} path prefix as the host-independent fallback. Every
// failure — HTTP, network, malformed body — surfaces as ApiError, never
// anything else.

import type {
  BrandSlot,
  Category,
  Currency,
  DemurrageBand,
  DirectoryMember,
  EmailTemplate,
  EmailTemplateKind,
  Flag,
  Group,
  Image,
  Listing,
  ListingType,
  Me,
  Member,
  MemberRole,
  MemberStatus,
  NewsItem,
  Page,
  PageVisibility,
  PendingItem,
  Policy,
  Restriction,
  ShellInfo,
  StatementLine,
  TradeStats,
  Transaction,
} from './types.js';
import type { CreditPolicyConfig, CreditPolicyType, TxState, TxType } from './types.js';

/** The server's {error: {code, message}} shape, plus the HTTP status. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ApiClientOptions {
  /** Origin prefix, e.g. 'http://localhost:1862'. Default '' (same origin). */
  baseUrl?: string;
  /** Group slug for /g/{slug} path mode; omit for hostname (custom domain) mode. */
  group?: string;
}

export type TxAction = 'accept' | 'decline' | 'cancel';
export type MemberAction = 'approve' | 'suspend' | 'reinstate' | 'remove';

export interface PayInput {
  payeeMemberId: string;
  currencyId: string;
  amount: number; // minor units
  description?: string;
}

export interface InvoiceInput {
  payerMemberId: string;
  currencyId: string;
  amount: number; // minor units
  description?: string;
}

export interface ListingInput {
  type: ListingType;
  title: string;
  description: string;
  categoryId: string;
  priceAmount?: number;
  priceCurrencyId?: string;
  rateText?: string;
  expiresAt?: string;
}

export interface ApplicationInput {
  displayName: string;
  personName: string;
  email: string;
  password: string;
}

export interface PolicyInput {
  currencyId: string;
  type: CreditPolicyType;
  config: CreditPolicyConfig;
}

export interface TransactionFilter {
  q?: string;
  memberId?: string;
  currencyId?: string;
  type?: TxType;
  state?: TxState;
  limit?: number;
  offset?: number;
}

export interface PageInput {
  slug: string;
  title: string;
  body: string; // markdown source (decision #13)
  visibility: PageVisibility;
  position?: number;
}

export interface NewsInput {
  title: string;
  body: string; // markdown source (decision #13)
  publishedAt?: string; // server defaults to now when omitted
  expiresAt?: string;
}

export interface CreateGroupInput {
  slug: string;
  name: string;
  hostname?: string;
  currency: { code: string; name: string; scale?: number; demurrageDay?: number };
  admin?: { displayName: string; personName: string; email: string; password?: string };
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly group: string | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.group = options.group;
  }

  /** Group-scoped API prefix: hostname mode or the /g/{slug} fallback. */
  groupPath(): string {
    return this.group === undefined ? '/api/v1' : `/api/v1/g/${this.group}`;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'include' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return this.send<T>(path, init);
  }

  /** Raw (non-JSON) request body, e.g. an image Blob (decision #14). */
  private rawRequest<T>(
    method: string,
    path: string,
    body: BodyInit,
    contentType: string,
  ): Promise<T> {
    return this.send<T>(path, {
      method,
      credentials: 'include',
      headers: { 'content-type': contentType },
      body,
    });
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, init);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ApiError('NETWORK', `cannot reach ${path}: ${detail}`, 0);
    }
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)
        ?.error;
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      const message =
        typeof error?.message === 'string'
          ? error.message
          : `${response.status} ${response.statusText}`;
      throw new ApiError(code, message, response.status);
    }
    return parsed as T;
  }

  private tenant<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, this.groupPath() + path, body);
  }

  private operator<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, `/api/v1/operator${path}`, body);
  }

  // --- Auth and profile ------------------------------------------------------

  login(email: string, password: string): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/auth/login', { email, password });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/auth/logout');
  }

  me(): Promise<Me> {
    return this.tenant('GET', '/me');
  }

  updateMe(patch: {
    confirmIncoming?: boolean;
    displayName?: string;
  }): Promise<{ member: Member }> {
    return this.tenant('PATCH', '/me', patch);
  }

  statement(currencyId: string): Promise<{ lines: StatementLine[] }> {
    return this.tenant('GET', `/me/statement?${new URLSearchParams({ currencyId })}`);
  }

  pending(): Promise<{ pending: PendingItem[] }> {
    return this.tenant('GET', '/me/pending');
  }

  // Profile photo (decision #14 phase 2): upload sends the raw image bytes as
  // the request body with the image's content type — not JSON, not multipart.

  setMyPhoto(data: Blob, mime: string): Promise<{ image: Image }> {
    return this.rawRequest('POST', `${this.groupPath()}/me/photo`, data, mime);
  }

  deleteMyPhoto(): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', '/me/photo');
  }

  // --- Shell chrome (decision #15) ---------------------------------------------

  /** Public, session-aware shell info the app's client-rendered chrome uses. */
  shellInfo(): Promise<ShellInfo> {
    return this.tenant('GET', '/shell');
  }

  // --- Directory and trading --------------------------------------------------

  members(): Promise<{ members: DirectoryMember[] }> {
    return this.tenant('GET', '/members');
  }

  member(id: string): Promise<{ member: DirectoryMember; stats: TradeStats }> {
    return this.tenant('GET', `/members/${encodeURIComponent(id)}`);
  }

  pay(input: PayInput): Promise<{ transaction: Transaction }> {
    return this.tenant('POST', '/payments', input);
  }

  invoice(input: InvoiceInput): Promise<{ transaction: Transaction }> {
    return this.tenant('POST', '/invoices', input);
  }

  txAction(id: string, action: TxAction): Promise<{ transaction: Transaction }> {
    return this.tenant('POST', `/transactions/${encodeURIComponent(id)}/${action}`);
  }

  // --- Marketplace and applications --------------------------------------------

  browse(filter: { type?: ListingType; categoryId?: string } = {}): Promise<{
    listings: Listing[];
  }> {
    const params = new URLSearchParams();
    if (filter.type !== undefined) params.set('type', filter.type);
    if (filter.categoryId !== undefined) params.set('categoryId', filter.categoryId);
    const query = params.toString();
    return this.tenant('GET', query === '' ? '/listings' : `/listings?${query}`);
  }

  postListing(input: ListingInput): Promise<{ listing: Listing }> {
    return this.tenant('POST', '/listings', input);
  }

  categories(): Promise<{ categories: Category[] }> {
    return this.tenant('GET', '/categories');
  }

  currencies(): Promise<{ currencies: Currency[] }> {
    return this.tenant('GET', '/currencies');
  }

  // Listing photos (decision #14 phase 3): upload sends the raw image bytes
  // as the request body with the image's content type — not JSON, not
  // multipart. Owner-only; the server caps each listing at 5 photos.

  addListingPhoto(listingId: string, data: Blob, mime: string): Promise<{ image: Image }> {
    return this.rawRequest(
      'POST',
      `${this.groupPath()}/listings/${encodeURIComponent(listingId)}/photos`,
      data,
      mime,
    );
  }

  removeListingPhoto(listingId: string, imageId: string): Promise<{ ok: boolean }> {
    return this.tenant(
      'DELETE',
      `/listings/${encodeURIComponent(listingId)}/photos/${encodeURIComponent(imageId)}`,
    );
  }

  apply(input: ApplicationInput): Promise<{ member: Member }> {
    return this.tenant('POST', '/applications', input);
  }

  // --- Admin ---------------------------------------------------------------

  adminMembers(status?: MemberStatus): Promise<{ members: Member[] }> {
    const query = status === undefined ? '' : `?${new URLSearchParams({ status })}`;
    return this.tenant('GET', `/admin/members${query}`);
  }

  adminMemberAction(id: string, action: MemberAction): Promise<{ member: Member }> {
    return this.tenant('POST', `/admin/members/${encodeURIComponent(id)}/${action}`);
  }

  adminSetRole(id: string, role: MemberRole): Promise<{ member: Member }> {
    return this.tenant('POST', `/admin/members/${encodeURIComponent(id)}/role`, { role });
  }

  adminPolicies(): Promise<{ policies: Policy[] }> {
    return this.tenant('GET', '/admin/policies');
  }

  adminAddPolicy(input: PolicyInput): Promise<{ policy: Policy }> {
    return this.tenant('POST', '/admin/policies', input);
  }

  adminPatchPolicy(
    id: string,
    patch: { enabled?: boolean; config?: CreditPolicyConfig },
  ): Promise<{ policy: Policy }> {
    return this.tenant('PATCH', `/admin/policies/${encodeURIComponent(id)}`, patch);
  }

  adminGetBands(currencyId: string): Promise<{ bands: DemurrageBand[] }> {
    return this.tenant(
      'GET',
      `/admin/demurrage/${encodeURIComponent(currencyId)}/bands`,
    );
  }

  adminSetBands(
    currencyId: string,
    bands: DemurrageBand[],
  ): Promise<{ bands: DemurrageBand[] }> {
    return this.tenant('PUT', `/admin/demurrage/${encodeURIComponent(currencyId)}/bands`, {
      bands,
    });
  }

  adminRestrictions(): Promise<{ restrictions: Restriction[] }> {
    return this.tenant('GET', '/admin/restrictions');
  }

  adminRestrict(memberId: string, reason: string): Promise<{ restriction: Restriction }> {
    return this.tenant('POST', '/admin/restrictions', { memberId, reason });
  }

  adminUnrestrict(memberId: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/restrictions/${encodeURIComponent(memberId)}`);
  }

  adminFlags(currencyId: string): Promise<{ flags: Flag[] }> {
    return this.tenant('GET', `/admin/flags?${new URLSearchParams({ currencyId })}`);
  }

  adminTransactions(filter: TransactionFilter = {}): Promise<{
    transactions: Transaction[];
    total: number;
  }> {
    const params = new URLSearchParams();
    if (filter.q !== undefined) params.set('q', filter.q);
    if (filter.memberId !== undefined) params.set('memberId', filter.memberId);
    if (filter.currencyId !== undefined) params.set('currencyId', filter.currencyId);
    if (filter.type !== undefined) params.set('type', filter.type);
    if (filter.state !== undefined) params.set('state', filter.state);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString();
    return this.tenant(
      'GET',
      query === '' ? '/admin/transactions' : `/admin/transactions?${query}`,
    );
  }

  adminReverse(id: string): Promise<{ transaction: Transaction }> {
    return this.tenant('POST', `/admin/transactions/${encodeURIComponent(id)}/reverse`);
  }

  adminCreateCategory(input: {
    name: string;
    parentId?: string;
  }): Promise<{ category: Category }> {
    return this.tenant('POST', '/admin/categories', input);
  }

  adminUpdateCategory(
    id: string,
    patch: { name?: string; parentId?: string },
  ): Promise<{ category: Category }> {
    return this.tenant('PATCH', `/admin/categories/${encodeURIComponent(id)}`, patch);
  }

  // --- CMS content (decision #13) --------------------------------------------

  adminPages(): Promise<{ pages: Page[] }> {
    return this.tenant('GET', '/admin/pages');
  }

  adminCreatePage(input: PageInput): Promise<{ page: Page }> {
    return this.tenant('POST', '/admin/pages', input);
  }

  adminUpdatePage(id: string, patch: Partial<PageInput>): Promise<{ page: Page }> {
    return this.tenant('PATCH', `/admin/pages/${encodeURIComponent(id)}`, patch);
  }

  adminDeletePage(id: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/pages/${encodeURIComponent(id)}`);
  }

  // CMS images (decision #14): upload sends the raw image bytes as the request
  // body with the image's content type — not JSON, not multipart.

  adminImages(): Promise<{ images: Image[] }> {
    return this.tenant('GET', '/admin/images');
  }

  adminUploadImage(data: Blob, mime: string): Promise<{ image: Image }> {
    return this.rawRequest('POST', `${this.groupPath()}/admin/images`, data, mime);
  }

  adminDeleteImage(id: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/images/${encodeURIComponent(id)}`);
  }

  // Group skinning (#15): one brand image per slot (logo | header),
  // replace-on-upload; the current state is the brand-filtered image list.

  adminBrandImages(): Promise<{ images: Image[] }> {
    return this.tenant('GET', '/admin/images?ownerKind=brand');
  }

  setBrandImage(slot: BrandSlot, data: Blob, mime: string): Promise<{ image: Image }> {
    return this.rawRequest('PUT', `${this.groupPath()}/admin/branding/${slot}`, data, mime);
  }

  deleteBrandImage(slot: BrandSlot): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/branding/${slot}`);
  }

  // Email templates and per-group sender (decision #16): PUT stores a group
  // override for the kind, DELETE reverts it to the built-in default;
  // emailFrom: null on the group PATCH clears the per-group sender so
  // delivery falls back to the instance-wide address.

  adminEmailTemplates(): Promise<{ templates: EmailTemplate[] }> {
    return this.tenant('GET', '/admin/email-templates');
  }

  putEmailTemplate(
    kind: EmailTemplateKind,
    input: { subject: string; body: string },
  ): Promise<{ template: EmailTemplate }> {
    return this.tenant('PUT', `/admin/email-templates/${encodeURIComponent(kind)}`, input);
  }

  deleteEmailTemplate(kind: EmailTemplateKind): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/email-templates/${encodeURIComponent(kind)}`);
  }

  adminGroup(): Promise<{ group: Group }> {
    return this.tenant('GET', '/admin/group');
  }

  patchAdminGroup(patch: {
    name?: string;
    emailFrom?: string | null;
  }): Promise<{ group: Group }> {
    return this.tenant('PATCH', '/admin/group', patch);
  }

  adminNews(): Promise<{ news: NewsItem[] }> {
    return this.tenant('GET', '/admin/news');
  }

  adminCreateNews(input: NewsInput): Promise<{ newsItem: NewsItem }> {
    return this.tenant('POST', '/admin/news', input);
  }

  adminUpdateNews(
    id: string,
    patch: Partial<NewsInput>,
  ): Promise<{ newsItem: NewsItem }> {
    return this.tenant('PATCH', `/admin/news/${encodeURIComponent(id)}`, patch);
  }

  adminDeleteNews(id: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/news/${encodeURIComponent(id)}`);
  }

  // --- Operator (platform level, outside any tenant) -------------------------

  operatorLogin(email: string, password: string): Promise<{ ok: boolean }> {
    return this.operator('POST', '/login', { email, password });
  }

  operatorGroups(): Promise<{ groups: Group[] }> {
    return this.operator('GET', '/groups');
  }

  operatorCreateGroup(input: CreateGroupInput): Promise<{
    group: Group;
    currency: Currency;
    admin?: Member;
  }> {
    return this.operator('POST', '/groups', input);
  }
}

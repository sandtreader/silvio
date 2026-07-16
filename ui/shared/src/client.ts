// Typed HTTP client over global fetch for the Silvio REST API, shared by the
// member and admin UIs. Same-origin cookie sessions (credentials: 'include');
// tenancy follows the server (decision #2): hostname mode by default, with
// the /api/v1/g/{slug} path prefix as the host-independent fallback. Every
// failure — HTTP, network, malformed body — surfaces as ApiError, never
// anything else.

import type {
  AdminAuditEvent,
  AdminStats,
  AdminTransaction,
  ApiScope,
  ApiToken,
  BrandSlot,
  Category,
  Currency,
  DecodedPaymentRequest,
  DemurrageBand,
  DemurrageRun,
  DigestFrequency,
  DirectoryMember,
  EmailTemplate,
  EmailTemplateKind,
  Flag,
  Group,
  GroupBalance,
  GroupSettings,
  Image,
  Listing,
  ListingBadge,
  ListingType,
  Me,
  Member,
  MemberRole,
  MemberStatus,
  NewsItem,
  OperatorGroup,
  OperatorGroupPatch,
  Page,
  PageVisibility,
  PaymentRequestInput,
  PendingItem,
  Person,
  Policy,
  Restriction,
  SearchDomain,
  SearchResult,
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

/** POST /me/tokens body (decision #9). Amount caps are integer minor units;
 * maxPeriodAmount and periodDays must be given together; trade:autonomous
 * requires maxTxAmount (the server enforces both). */
export interface CreateTokenInput {
  label: string;
  scopes: ApiScope[];
  maxTxAmount?: number;
  maxPeriodAmount?: number;
  periodDays?: number;
  expiresAt?: string;
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

export interface AuditFilter {
  action?: string;
  entityType?: string;
  entityId?: string;
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

  // Password reset and email verification: forgot always returns ok (no
  // account enumeration); reset/verify consume a single-use emailed token
  // and 400 when it is invalid, expired or already used.

  forgotPassword(email: string): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/auth/forgot', { email });
  }

  resetPassword(token: string, password: string): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/auth/reset', { token, password });
  }

  verifyEmail(token: string): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/auth/verify', { token });
  }

  /** Joint-member invite acceptance (#23): single-use emailed token + the
   * invitee's chosen password; 400 when invalid, expired or already used. */
  acceptInvite(token: string, password: string): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/auth/accept-invite', { token, password });
  }

  me(): Promise<Me> {
    return this.tenant('GET', '/me');
  }

  /** End an acts-for-member session (#24); a no-op when not acting. */
  stopActing(): Promise<{ ok: boolean }> {
    return this.tenant('POST', '/me/stop-acting');
  }

  updateMe(patch: {
    confirmIncoming?: boolean;
    displayName?: string;
    digestFrequency?: DigestFrequency; // offers & wants digest cadence (#17)
    neighbourhood?: string | null; // free-text locality; null clears
  }): Promise<{ member: Member }> {
    return this.tenant('PATCH', '/me', patch);
  }

  statement(
    currencyId: string,
    page?: { limit?: number; offset?: number },
  ): Promise<{ lines: StatementLine[]; total: number }> {
    const params = new URLSearchParams({ currencyId });
    if (page?.limit !== undefined) params.set('limit', String(page.limit));
    if (page?.offset !== undefined) params.set('offset', String(page.offset));
    return this.tenant('GET', `/me/statement?${params}`);
  }

  /** Same-origin href for the CSV statement download (cookie auth). */
  statementCsvUrl(currencyId: string): string {
    return `${this.groupPath()}/me/statement.csv?${new URLSearchParams({ currencyId })}`;
  }

  // Group balances transparency view (#19): 404 unless the group opts in.
  groupBalances(currencyId: string): Promise<{ balances: GroupBalance[] }> {
    return this.tenant('GET', `/balances?${new URLSearchParams({ currencyId })}`);
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

  // Joint memberships (#23): the persons sharing this membership. Adding an
  // email with no account sends a 7-day invite (an existing account links
  // silently); removal revokes that person's access to this membership and
  // 422s when they are the last one.

  myPersons(): Promise<{ persons: Person[] }> {
    return this.tenant('GET', '/me/persons');
  }

  addPerson(name: string, email: string): Promise<{ person: Person }> {
    return this.tenant('POST', '/me/persons', { name, email });
  }

  removePerson(id: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/me/persons/${encodeURIComponent(id)}`);
  }

  // API tokens (decision #9): personal access tokens for MCP agents/apps.
  // Cookie-session-only routes by design — a token can never manage tokens.
  // The raw value appears exactly once, in the creation response.

  myTokens(): Promise<{ tokens: ApiToken[] }> {
    return this.tenant('GET', '/me/tokens');
  }

  createToken(input: CreateTokenInput): Promise<{ token: string; apiToken: ApiToken }> {
    return this.tenant('POST', '/me/tokens', input);
  }

  revokeToken(id: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/me/tokens/${encodeURIComponent(id)}`);
  }

  // --- Shell chrome (decision #15) ---------------------------------------------

  /** Public, session-aware shell info the app's client-rendered chrome uses. */
  shellInfo(): Promise<ShellInfo> {
    return this.tenant('GET', '/shell');
  }

  // --- Directory and trading --------------------------------------------------

  members(filter?: { neighbourhood?: string }): Promise<{ members: DirectoryMember[] }> {
    if (filter?.neighbourhood === undefined) return this.tenant('GET', '/members');
    const params = new URLSearchParams({ neighbourhood: filter.neighbourhood });
    return this.tenant('GET', `/members?${params}`);
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

  // Signed QR payment requests (decision #22): the payee mints an opaque,
  // server-signed payload; the payer decodes it for a verified confirm screen
  // (trusted payee name/amount) and commits via /payments/scan, which is
  // idempotent per payload — a double scan replays the same transaction.

  mintPaymentRequest(input: PaymentRequestInput): Promise<{ payload: string }> {
    return this.tenant('POST', '/me/payment-requests', input);
  }

  decodePaymentRequest(payload: string): Promise<DecodedPaymentRequest> {
    return this.tenant(
      'GET',
      `/payment-requests/decode?${new URLSearchParams({ payload })}`,
    );
  }

  /** amount only for open-amount requests; fixed ones carry their own. */
  scanPayment(payload: string, amount?: number): Promise<{ transaction: Transaction }> {
    const body: { payload: string; amount?: number } = { payload };
    if (amount !== undefined) body.amount = amount;
    return this.tenant('POST', '/payments/scan', body);
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

  /** Owner-only: push the listing's expiry out by the group's shelf life (#18). */
  renewListing(id: string): Promise<{ listing: Listing }> {
    return this.tenant('POST', `/listings/${encodeURIComponent(id)}/renew`);
  }

  /** Full-text search within one domain (#18). Public route; a session
   * raises the visibility tier (e.g. members-only pages appear). */
  search(
    domain: SearchDomain,
    q: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: SearchResult[]; total: number }> {
    const params = new URLSearchParams({ domain, q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    return this.tenant('GET', `/search?${params.toString()}`);
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

  /** Replace a listing's admin-verified badges (#8). */
  adminSetListingBadges(id: string, badges: ListingBadge[]): Promise<{ listing: Listing }> {
    return this.tenant('PUT', `/admin/listings/${encodeURIComponent(id)}/badges`, { badges });
  }

  /** Act for a member (#24): the session presents as them until stopActing;
   * every action is attributed to the admin and audited. */
  actAsMember(id: string): Promise<{ ok: boolean }> {
    return this.tenant('POST', `/admin/members/${encodeURIComponent(id)}/act-as`);
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

  adminDeletePolicy(id: string): Promise<{ ok: boolean }> {
    return this.tenant('DELETE', `/admin/policies/${encodeURIComponent(id)}`);
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

  /** Demurrage run history, newest first. */
  adminRuns(): Promise<{ runs: DemurrageRun[] }> {
    return this.tenant('GET', '/admin/runs');
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

  /** Dashboard stats for one currency: balance distribution, monthly trade
   *  flow, 30-day velocity and dormant members. */
  adminStats(currencyId: string): Promise<AdminStats> {
    return this.tenant('GET', `/admin/stats?${new URLSearchParams({ currencyId })}`);
  }

  adminTransactions(filter: TransactionFilter = {}): Promise<{
    transactions: AdminTransaction[];
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

  /** Audit log, newest first; the server defaults limit to 50. */
  adminAudit(filter: AuditFilter = {}): Promise<{ events: AdminAuditEvent[]; total: number }> {
    const params = new URLSearchParams();
    if (filter.action !== undefined) params.set('action', filter.action);
    if (filter.entityType !== undefined) params.set('entityType', filter.entityType);
    if (filter.entityId !== undefined) params.set('entityId', filter.entityId);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString();
    return this.tenant('GET', query === '' ? '/admin/audit' : `/admin/audit?${query}`);
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

  /** Delete a category; moveTo recategorises its listings first. */
  adminDeleteCategory(id: string, moveTo?: string): Promise<{ ok: boolean; moved: number }> {
    const query = moveTo === undefined ? '' : `?moveTo=${encodeURIComponent(moveTo)}`;
    return this.tenant('DELETE', `/admin/categories/${encodeURIComponent(id)}${query}`);
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
    settings?: GroupSettings; // replaces the whole object; absent keys → platform defaults
  }): Promise<{ group: Group }> {
    return this.tenant('PATCH', '/admin/group', patch);
  }

  // Ad-hoc broadcast (decision #17): markdown body, one email per person on
  // an active membership, queued through the standard outbox. No storage of
  // its own — the email_events log records what was sent to whom.

  adminBroadcast(subject: string, body: string): Promise<{ ok: boolean; queued: number }> {
    return this.tenant('POST', '/admin/broadcast', { subject, body });
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

  // --- Operator (platform level, outside any tenant; decision #21) -----------

  operatorLogin(email: string, password: string): Promise<{ ok: boolean }> {
    return this.operator('POST', '/login', { email, password });
  }

  operatorGroups(): Promise<{ groups: OperatorGroup[] }> {
    return this.operator('GET', '/groups');
  }

  provisionGroup(input: CreateGroupInput): Promise<{
    group: Group;
    currency: Currency;
    admin?: Member;
  }> {
    return this.operator('POST', '/groups', input);
  }

  patchOperatorGroup(
    id: string,
    patch: OperatorGroupPatch,
  ): Promise<{ group: OperatorGroup }> {
    return this.operator('PATCH', `/groups/${encodeURIComponent(id)}`, patch);
  }

  addGroupDomain(id: string, hostname: string): Promise<{ ok: boolean }> {
    return this.operator('POST', `/groups/${encodeURIComponent(id)}/domains`, {
      hostname,
    });
  }

  removeGroupDomain(id: string, hostname: string): Promise<{ ok: boolean }> {
    return this.operator(
      'DELETE',
      `/groups/${encodeURIComponent(id)}/domains/${encodeURIComponent(hostname)}`,
    );
  }
}

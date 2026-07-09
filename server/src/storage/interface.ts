// Pluggable storage interface (decision #6 and specs/data-model.md).
// The ledger contract: post/transition are atomic; balances always equal the
// sum of committed entries; whether they are derived or cached is the
// implementation's private decision.

import type {
  Account,
  AccountType,
  ApiScope,
  ApiToken,
  Category,
  MemberRole,
  Session,
  User,
  CreditPolicy,
  CreditPolicyConfig,
  CreditPolicyType,
  Currency,
  DemurrageBand,
  DemurrageRun,
  EmailEvent,
  Group,
  Id,
  Image,
  ImageOwnerKind,
  Listing,
  ListingStatus,
  ListingType,
  Member,
  MemberStatus,
  MemberType,
  NewTransaction,
  NewsItem,
  Page,
  PageVisibility,
  Person,
  Restriction,
  StatementLine,
  TradeStats,
  Transaction,
  TxState,
  TxType,
  VerifyReport,
} from '../types.js';

export interface CreateGroupInput {
  slug: string;
  name: string;
}

export interface CreateCurrencyInput {
  groupId: Id;
  code: string;
  name: string;
  scale?: number; // default 0
  demurrageDay?: number; // 1-28; absent = demurrage off
}

export interface CreateAccountInput {
  groupId: Id;
  currencyId: Id;
  type: AccountType;
  memberId?: Id;
  counterpartyRef?: string;
}

export interface Actor {
  personId: Id; // or 'system'
}

/** Outbound email to enqueue (data-model §6). */
export interface EnqueueEmailInput {
  groupId: Id;
  personId: Id;
  kind: string;
  dedupKey: string;
  toEmail: string;
  subject: string;
  body: string;
  createdAt: string;
}

/** CMS page to create (decision #13, data-model §6). body is markdown source. */
export interface CreatePageInput {
  groupId: Id;
  slug: string;
  title: string;
  body: string;
  visibility: PageVisibility;
  position?: number; // default 0
}

/** News item to create (decision #13, data-model §6). body is markdown source. */
export interface CreateNewsItemInput {
  groupId: Id;
  title: string;
  body: string;
  publishedAt: string;
  expiresAt?: string;
}

/** Image to store (decision #14). size is derived from data.length. */
export interface CreateImageInput {
  groupId: Id;
  ownerKind: ImageOwnerKind;
  ownerId?: Id; // absent for cms images
  mime: string;
  data: Buffer;
  createdBy: Id;
}

/** listImages filter (decision #14). AND-composed; {} lists the whole group. */
export interface ImageFilter {
  ownerKind?: ImageOwnerKind;
  ownerId?: Id;
}

/** Admin transaction search (todo: API polish). All fields optional; AND-composed. */
export interface TransactionFilter {
  /** Transactions with at least one entry on any account of this member. */
  memberId?: Id;
  /** Transactions with at least one entry on an account in this currency. */
  currencyId?: Id;
  type?: TxType;
  state?: TxState;
  /** Case-insensitive substring over description or reference. */
  text?: string;
  limit?: number; // default 50, capped at 200
  offset?: number; // default 0
}

export interface Ledger {
  /**
   * Atomically validate and record a transaction (decision #6).
   * - legs grouped by their account's currency must each sum to zero
   * - >= 2 legs, integer non-zero amounts, all accounts in tx.groupId
   * - initial state 'committed' assigns seq/hash/committedAt and takes
   *   balance effect; 'pending' records with none of those (decision #5)
   * - idempotencyKey (unique per group): a replay returns the original
   *   transaction without posting again
   */
  post(tx: NewTransaction, idempotencyKey?: string): Promise<Transaction>;

  /**
   * #5 state machine: pending -> committed | declined | cancelled | expired.
   * Committing assigns seq/hash/committedAt and takes balance effect.
   * Any other edge throws INVALID_TRANSITION.
   */
  transition(txId: Id, to: TxState, actor: Actor): Promise<Transaction>;

  getTransaction(txId: Id): Promise<Transaction>;

  /** Sum of committed entries only. */
  balance(accountId: Id): Promise<number>;

  /** Committed lines for an account, ordered by seq, with running balance. */
  statement(accountId: Id): Promise<StatementLine[]>;

  /**
   * Recompute balances, hash chain, and seq==chain-order from the journal
   * (decisions #6, #10). Any mismatch is reported, never silent.
   */
  verify(groupId: Id): Promise<VerifyReport>;
}

export interface Storage extends Ledger {
  createGroup(input: CreateGroupInput): Promise<Group>;
  listGroups(): Promise<Group[]>;
  createCurrency(input: CreateCurrencyInput): Promise<Currency>;
  createAccount(input: CreateAccountInput): Promise<Account>;

  /** Open (unclosed) accounts of a currency; optionally filtered by type. */
  listAccounts(groupId: Id, currencyId: Id): Promise<Account[]>;

  // Demurrage config and runs (decision #1). The engine itself is domain
  // logic in src/ledger/demurrage.ts; storage only persists bands and runs.
  /** Replace the currency's bands. Must be valid: fromAmounts unique and >= 0, rates >= 0. */
  setDemurrageBands(currencyId: Id, bands: DemurrageBand[]): Promise<void>;
  demurrageBands(currencyId: Id): Promise<DemurrageBand[]>; // ordered by fromAmount

  /** Begin a run, or return the existing one for (currency, period) — idempotent. */
  beginDemurrageRun(groupId: Id, currencyId: Id, period: string): Promise<DemurrageRun>;
  completeDemurrageRun(runId: Id): Promise<DemurrageRun>;
  /** Committed transactions referencing this run (recovery: who is already charged). */
  transactionsForRun(runId: Id): Promise<Transaction[]>;

  // Users, sessions, tenancy resolution (decision #2, data-model §1).
  // Hashing is the auth service's job; storage only stores/matches hashes.
  createUser(input: { email: string; passwordHash: string }): Promise<User>;
  getUser(id: Id): Promise<User>;
  /** User + stored password hash for credential verification; undefined if unknown. */
  credentialsForEmail(
    email: string,
  ): Promise<{ user: User; passwordHash: string } | undefined>;
  setOperator(userId: Id, isOperator: boolean): Promise<User>;
  operatorExists(): Promise<boolean>;
  createSession(input: {
    userId: Id;
    memberId?: Id;
    tokenHash: string;
    expiresAt: string;
  }): Promise<Session>;
  sessionByTokenHash(tokenHash: string): Promise<Session | undefined>; // unrevoked only
  revokeSession(id: Id): Promise<void>;
  /** Memberships of a user across groups (via persons.user_id). */
  membersForUser(userId: Id): Promise<Member[]>;
  addGroupDomain(groupId: Id, hostname: string): Promise<void>;
  groupByDomain(hostname: string): Promise<Group | undefined>;
  groupBySlug(slug: string): Promise<Group | undefined>;

  // Members & persons (decision #7). memberNo assigned per group, sequential.
  createMember(input: {
    groupId: Id;
    displayName: string;
    type?: MemberType; // default 'individual'
    role?: MemberRole; // default 'member'
  }): Promise<Member>; // status 'applied'
  getMember(id: Id): Promise<Member>;
  updateMember(
    id: Id,
    patch: { displayName?: string; confirmIncoming?: boolean; role?: MemberRole },
  ): Promise<Member>;
  setMemberStatus(id: Id, status: MemberStatus): Promise<Member>;
  listMembers(groupId: Id, status?: MemberStatus): Promise<Member[]>;
  createPerson(input: {
    memberId: Id;
    userId?: Id;
    name: string;
    email?: string;
    isPrimary?: boolean;
  }): Promise<Person>;
  personsForMember(memberId: Id): Promise<Person[]>;

  listCurrencies(groupId: Id): Promise<Currency[]>;
  getAccount(id: Id): Promise<Account>;
  /** Get or create the member's account in a currency. */
  ensureMemberAccount(memberId: Id, currencyId: Id): Promise<Account>;
  accountsForMember(memberId: Id): Promise<Account[]>; // open accounts
  closeAccount(accountId: Id): Promise<void>;

  // Credit control (decision #3): persisted config; evaluation is domain logic.
  setCreditPolicy(input: {
    groupId: Id;
    currencyId: Id;
    type: CreditPolicyType;
    config: CreditPolicyConfig;
    enabled?: boolean; // default true
  }): Promise<CreditPolicy>;
  creditPolicies(groupId: Id, currencyId: Id): Promise<CreditPolicy[]>; // enabled only
  listCreditPolicies(groupId: Id): Promise<CreditPolicy[]>; // all, for admin UI
  updateCreditPolicy(
    id: Id,
    patch: { enabled?: boolean; config?: CreditPolicyConfig },
  ): Promise<CreditPolicy>;
  imposeRestriction(memberId: Id, reason: string, imposedBy: Id): Promise<Restriction>;
  liftRestriction(memberId: Id, liftedBy: Id): Promise<void>;
  activeRestriction(memberId: Id): Promise<Restriction | undefined>;
  activeRestrictions(groupId: Id): Promise<Restriction[]>; // unlifted, for group members, oldest first

  // API tokens (decision #9, data-model §7). Hashing is the token service's
  // job; storage stores/matches hashes only, like sessions.
  createApiToken(input: {
    memberId: Id;
    createdBy: Id; // person
    tokenHash: string;
    label: string;
    scopes: ApiScope[];
    maxTxAmount?: number;
    maxPeriodAmount?: number;
    periodDays?: number;
    expiresAt?: string;
  }): Promise<ApiToken>;
  /** Unrevoked only (expiry is the service's check). */
  apiTokenByHash(tokenHash: string): Promise<ApiToken | undefined>;
  /** All of a member's tokens, revoked included (for the management UI). */
  listApiTokens(memberId: Id): Promise<ApiToken[]>;
  revokeApiToken(id: Id): Promise<void>;
  touchApiToken(id: Id, atIso: string): Promise<void>; // lastUsedAt
  /**
   * Rolling spend via this token (decision #9): sum of the token member's
   * outward (negative) leg amounts, as a positive number, over committed
   * transactions with this apiTokenId and committedAt >= sinceIso.
   */
  tokenSpend(tokenId: Id, sinceIso: string): Promise<number>;

  /**
   * Filtered, paginated group transactions for the admin list, newest first
   * with a stable order (pagination never duplicates). `total` counts all
   * matches ignoring limit/offset.
   */
  listTransactions(
    groupId: Id,
    filter?: TransactionFilter,
  ): Promise<{ transactions: Transaction[]; total: number }>;

  // Outbound email log (data-model §6). Composition is the notification
  // service's job; storage only queues, lists and stamps events.
  /** Insert an email event; a duplicate dedupKey is a silent no-op returning undefined. */
  enqueueEmail(input: EnqueueEmailInput): Promise<EmailEvent | undefined>;
  /** Unsent events with fewer than 3 attempts, oldest first, up to limit. */
  pendingEmails(limit: number): Promise<EmailEvent[]>;
  markEmailSent(id: Id, sentAt: string): Promise<void>;
  /** Count a failed attempt; after 3 the event is no longer offered for delivery. */
  markEmailFailed(id: Id, error: string): Promise<void>;

  /** Pending transactions with expiresAt <= asOf (decision #5 sweeps). */
  pendingDue(groupId: Id, asOf: string): Promise<Transaction[]>;
  /** Pending transactions with a leg on any of the member's accounts. */
  pendingForMember(memberId: Id): Promise<Transaction[]>;
  /** Trade-count stats from committed 'trade' transactions (decision #8). */
  tradeStats(memberId: Id): Promise<TradeStats>;

  // Marketplace.
  createCategory(input: { groupId: Id; name: string; parentId?: Id }): Promise<Category>;
  getCategory(id: Id): Promise<Category>;
  updateCategory(id: Id, patch: { name?: string; parentId?: Id }): Promise<Category>;
  listCategories(groupId: Id): Promise<Category[]>;
  createListing(input: {
    groupId: Id;
    memberId: Id;
    type: ListingType;
    title: string;
    description: string;
    categoryId: Id;
    priceAmount?: number;
    priceCurrencyId?: Id;
    rateText?: string;
    expiresAt?: string;
  }): Promise<Listing>;
  getListing(id: Id): Promise<Listing>;
  updateListing(
    id: Id,
    patch: Partial<{
      title: string;
      description: string;
      categoryId: Id;
      priceAmount: number;
      priceCurrencyId: Id;
      rateText: string;
      status: ListingStatus;
      expiresAt: string;
    }>,
  ): Promise<Listing>;
  listListings(
    groupId: Id,
    filter?: {
      type?: ListingType;
      categoryId?: Id;
      memberId?: Id;
      status?: ListingStatus; // default 'active'
    },
  ): Promise<Listing[]>;

  // CMS pages (decision #13, data-model §6). A duplicate (groupId, slug) is
  // a CONFLICT; slugs are only unique within their group.
  /** Create a page; position defaults to 0, timestamps are set here. */
  createPage(input: CreatePageInput): Promise<Page>;
  getPage(id: Id): Promise<Page>;
  pageBySlug(groupId: Id, slug: string): Promise<Page | undefined>;
  /** Pages of a group, ordered by position then slug. */
  listPages(groupId: Id): Promise<Page[]>;
  updatePage(
    id: Id,
    patch: Partial<{
      slug: string;
      title: string;
      body: string;
      visibility: PageVisibility;
      position: number;
    }>,
  ): Promise<Page>;
  deletePage(id: Id): Promise<void>;

  // News items (decision #13, data-model §6): the community noticeboard,
  // always public, shown from publishedAt until expiresAt (if set).
  /** Create a news item; timestamps are set here. */
  createNewsItem(input: CreateNewsItemInput): Promise<NewsItem>;
  getNewsItem(id: Id): Promise<NewsItem>;
  /**
   * News of a group, newest publishedAt first. With currentAt only items
   * already published (publishedAt <= currentAt) and not yet expired
   * (no expiresAt, or expiresAt > currentAt).
   */
  listNews(groupId: Id, filter: { currentAt?: string }): Promise<NewsItem[]>;
  updateNewsItem(
    id: Id,
    patch: Partial<{
      title: string;
      body: string;
      publishedAt: string;
      expiresAt: string;
    }>,
  ): Promise<NewsItem>;
  deleteNewsItem(id: Id): Promise<void>;

  // Images (decision #14): one general blob store, three owners. Blobs stay
  // behind this interface — domain objects carry metadata only, and the
  // bytes surface exclusively via imageData for the /i/ serving route.
  createImage(input: CreateImageInput): Promise<Image>;
  getImage(id: Id): Promise<Image>; // metadata only
  imageData(id: Id): Promise<Buffer>;
  /** Group images, metadata only, upload order (never selects the blob). */
  listImages(groupId: Id, filter: ImageFilter): Promise<Image[]>;
  deleteImage(id: Id): Promise<void>;
  /** Sum of the group's image sizes in bytes; 0 when none (quota check, #14). */
  imagesTotalSize(groupId: Id): Promise<number>;

  close(): void;
}

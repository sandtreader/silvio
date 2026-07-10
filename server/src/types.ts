// Domain types, from specs/data-model.md.
// Money: integer minor units (decision #6). JS numbers are safe well beyond
// any LETS balance; the storage layer rejects non-integers and unsafe values.

export type Id = string;

export type AccountType = 'member' | 'community' | 'system' | 'gateway';

export type TxType =
  | 'trade'
  | 'demurrage'
  | 'fee'
  | 'settlement'
  | 'reversal'
  | 'adjustment';

export type TxState =
  | 'pending'
  | 'committed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export type TxFlow = 'payment' | 'invoice';

export type Channel = 'web' | 'mcp' | 'admin' | 'system';

// Publishing member balances is the group's explicit cultural choice (#19).
export type Transparency = 'none' | 'balances';

// Per-group knobs; absent keys mean the platform defaults (see
// services/settings.ts), so a group row never needs migrating.
export interface GroupSettings {
  autoAcceptDays?: number; // held-payment auto-accept horizon (#5)
  invoiceExpiryDays?: number; // invoice expiry horizon (#5)
  digestDefault?: DigestFrequency; // applied to new members at join (#17)
  listingMaxAgeDays?: number; // listing shelf life at post/renew time (#18)
  transparency?: Transparency; // group balances view visibility (#19)
}

// Group lifecycle (#20): suspended = read-only (logins and reads keep
// working; state changes refuse with GROUP_SUSPENDED).
export type GroupStatus = 'active' | 'suspended';

export interface Group {
  id: Id;
  slug: string;
  name: string;
  status: GroupStatus;
  // Operator's free-text plan label (#20) — a record, no billing logic.
  plan?: string;
  // Operator-private free text (#20): contacts, history. Kept out of the
  // shared GROUP schema so it never leaves operator routes.
  notes?: string;
  // Per-group sender address (#16); delivery falls back to the instance-wide
  // default when unset.
  emailFrom?: string;
  settings?: GroupSettings; // absent = all defaults
  createdAt: string;
}

export interface Currency {
  id: Id;
  groupId: Id;
  code: string;
  name: string;
  scale: number;
  demurrageDay?: number; // day-of-month for the posting run; absent = demurrage off (#1)
  createdAt: string;
}

export interface Account {
  id: Id;
  groupId: Id;
  currencyId: Id;
  type: AccountType;
  memberId?: Id;
  counterpartyRef?: string;
  createdAt: string;
  closedAt?: string;
}

export interface NewEntry {
  accountId: Id;
  amount: number; // signed, minor units, non-zero integer
}

export interface Entry extends NewEntry {
  id: Id;
  transactionId: Id;
}

export interface NewTransaction {
  groupId: Id;
  type: TxType;
  flow?: TxFlow;
  state: 'pending' | 'committed'; // initial state only (decision #5)
  description?: string;
  reference?: string;
  createdBy: Id;
  channel: Channel;
  reversesId?: Id;
  demurrageRunId?: Id;
  remoteRef?: string;
  apiTokenId?: Id;
  expiresAt?: string;
  entries: NewEntry[];
}

export interface Transaction {
  id: Id;
  groupId: Id;
  type: TxType;
  flow?: TxFlow;
  state: TxState;
  seq?: number; // per-group chain index, assigned at commit (decisions #6, #10)
  hash?: string; // journal hash chain, set at commit (decision #10)
  hashVersion?: number;
  description?: string;
  reference?: string;
  createdBy: Id;
  channel: Channel;
  reversesId?: Id;
  demurrageRunId?: Id;
  remoteRef?: string;
  apiTokenId?: Id;
  idempotencyKey?: string;
  createdAt: string;
  committedAt?: string;
  expiresAt?: string;
  entries: Entry[];
}

// Identity (decision #2): auth identity is global, membership is per-group.
export interface User {
  id: Id;
  email: string; // unique globally; login identifier
  status: 'active' | 'locked' | 'closed';
  isOperator: boolean; // platform super-admin (decision #2); never listed in groups
  createdAt: string;
  // Stamped by verifyEmail (data-model §1); recorded only — nothing enforces
  // verification yet.
  emailVerifiedAt?: string;
}

// One-time tokens (data-model §1): single-use expiring links for password
// reset and email verification ('invite' reserved for member invitations).
// The raw token only ever appears in the emailed URL; hashed at rest like
// sessions.
export type OneTimeTokenPurpose = 'password_reset' | 'email_verify' | 'invite';

export interface OneTimeToken {
  id: Id;
  userId?: Id; // absent for invites sent before a user exists
  email: string;
  purpose: OneTimeTokenPurpose;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
}

// Server-side revocable session, token hashed at rest (data-model §1).
export interface Session {
  id: Id;
  userId: Id;
  memberId?: Id; // selected group context (decision #2)
  actingMemberId?: Id; // admin acts-for-member (#24)
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

// Membership (decision #7).
export type MemberStatus = 'applied' | 'active' | 'away' | 'suspended' | 'closed';
export type MemberType = 'individual' | 'joint' | 'organisation';
export type MemberRole = 'member' | 'committee' | 'admin';
// Offers & wants digest cadence (#17); default 'weekly'.
export type DigestFrequency = 'none' | 'weekly' | 'monthly';

export interface Member {
  id: Id;
  groupId: Id;
  memberNo: number; // per-group sequential, human-friendly
  type: MemberType;
  role: MemberRole;
  displayName: string;
  status: MemberStatus;
  confirmIncoming: boolean; // opt-in payment confirmation (decision #5)
  digestFrequency: DigestFrequency; // offers & wants digest cadence (#17)
  neighbourhood?: string; // free-text locality shown in the directory
  appliedAt: string;
  approvedAt?: string;
  closedAt?: string;
  // Profile photo (#14 phase 2): derived from the images table (ownerKind
  // 'member'), populated at the API layer — not a member column.
  photoId?: Id;
}

export interface Person {
  id: Id;
  memberId: Id;
  userId?: Id; // absent for offline (buddy-managed) members
  isPrimary: boolean;
  name: string;
  email?: string;
}

// Credit control (decision #3).
export type CreditPolicyType = 'soft_threshold' | 'hard_limit';

export interface SoftThreshold {
  balance: number; // flag when balance passes this (sign gives direction)
  level: string; // e.g. 'notice' | 'review'
}

export interface CreditPolicyConfig {
  thresholds?: SoftThreshold[]; // soft_threshold
  minBalance?: number; // hard_limit (max debit)
  maxBalance?: number; // hard_limit (max credit)
}

export interface CreditPolicy {
  id: Id;
  groupId: Id;
  currencyId: Id;
  type: CreditPolicyType;
  config: CreditPolicyConfig;
  enabled: boolean;
}

export interface Restriction {
  id: Id;
  memberId: Id;
  reason: string;
  imposedBy: Id;
  imposedAt: string;
  liftedBy?: Id;
  liftedAt?: string;
}

// Computed by periodic evaluation; never blocking by itself (decision #3).
export interface AccountFlag {
  accountId: Id;
  memberId: Id;
  level: string;
  reason: string;
}

// Marketplace.
export type ListingType = 'offer' | 'want';
export type ListingStatus = 'active' | 'hidden' | 'expired';

export interface Category {
  id: Id;
  groupId: Id;
  name: string;
  parentId?: Id;
}

export interface Listing {
  id: Id;
  groupId: Id;
  memberId: Id;
  type: ListingType;
  title: string;
  description: string;
  categoryId: Id;
  priceAmount?: number; // minor units, with priceCurrencyId…
  priceCurrencyId?: Id;
  rateText?: string; // …or free text ("negotiable", "10/hr")
  status: ListingStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  // Listing photos (#14 phase 3): derived from the images table (ownerKind
  // 'listing'), populated at the API layer — not a listing column.
  photoIds?: Id[];
}

// Demurrage (decision #1): marginal bands per currency, monthly runs.
export interface DemurrageBand {
  fromAmount: number; // band start, minor units (first band typically 0)
  ratePpmPerMonth: number; // marginal rate in parts-per-million per month
}

export interface DemurrageRun {
  id: Id;
  groupId: Id;
  currencyId: Id;
  period: string; // "YYYY-MM", unique per currency
  status: 'running' | 'completed';
  startedAt: string;
  completedAt?: string;
}

// Trade-count profile stats (decision #8): computed from the journal,
// the evidence-backed substitute for ratings.
export interface TradeStats {
  trades: number; // committed trades involving the member
  partners: number; // distinct counterparty members
  lastTradeAt?: string;
}

// API tokens (decision #9, data-model §7): a token acts as one membership,
// with least-privilege scopes granted by the member. trade:autonomous is
// bounded by per-token caps; spend is computed from the journal via
// transactions.api_token_id — no separate counter to drift.
export type ApiScope =
  | 'marketplace:read'
  | 'directory:read'
  | 'account:read'
  | 'listings:write'
  | 'trade:request' // payments enter pending; the member confirms in the web UI
  | 'trade:autonomous'; // payments commit, bounded by the caps below

export const API_SCOPES: readonly ApiScope[] = [
  'marketplace:read',
  'directory:read',
  'account:read',
  'listings:write',
  'trade:request',
  'trade:autonomous',
];

export interface ApiToken {
  id: Id;
  memberId: Id;
  createdBy: Id; // person
  label: string;
  scopes: ApiScope[];
  maxTxAmount?: number; // required when trade:autonomous
  maxPeriodAmount?: number; // rolling spend cap, paired with periodDays
  periodDays?: number;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

// Outbound email log (data-model §6): one row per composed email. dedup_key
// makes enqueueing idempotent, so sweeps and retries never double-send; the
// row doubles as a troubleshooting trail (attempts, lastError).
export interface EmailEvent {
  id: Id;
  groupId: Id;
  personId: Id;
  kind: string; // e.g. 'welcome', 'invoice_received', 'restriction_imposed'
  dedupKey: string;
  toEmail: string;
  subject: string;
  body: string;
  // Group sender snapshotted at enqueue time (#16); absent means the
  // instance-wide default.
  fromEmail?: string;
  createdAt: string;
  sentAt?: string;
  attempts: number;
  lastError?: string;
}

// Email template override (#16): a row overrides the built-in default for
// (group, kind); deleting it reverts. subject and body carry {{placeholder}}
// markdown, substituted then rendered at delivery.
export interface EmailTemplate {
  id: Id;
  groupId: Id;
  kind: string;
  subject: string;
  body: string;
}

// CMS pages (decision #13, data-model §6): per-group content, slug-addressed.
// body is markdown source; rendering happens at the edge (renderMarkdown).
export type PageVisibility = 'public' | 'members' | 'admin';

export interface Page {
  id: Id;
  groupId: Id;
  slug: string; // unique within the group
  title: string;
  body: string; // markdown source (#13)
  visibility: PageVisibility;
  position: number; // menu ordering, ascending
  createdAt: string;
  updatedAt: string;
}

// News items (decision #13, data-model §6): the community noticeboard.
// Always public — no visibility field; an item shows from publishedAt until
// expiresAt (if set). body is markdown source, rendered at the edge.
export interface NewsItem {
  id: Id;
  groupId: Id;
  title: string;
  body: string; // markdown source (#13)
  publishedAt: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Generic search (data-model Search interface): one request shape across the
// searchable domains; how it's indexed is the storage layer's private
// decision (SQLite: FTS5).
export type SearchDomain = 'listings' | 'directory' | 'pages' | 'news';

/** Caller's tier — results respect it (#2). */
export type SearchVisibility = 'public' | 'member' | 'admin';

export interface SearchResult {
  domain: SearchDomain;
  id: Id;
  title: string;
  snippet?: string; // short match highlight, when available
}

// Images (decision #14): one general blob store, four owners. This is the
// metadata projection only — the bytes stay behind the storage interface
// (imageData) and are never carried on the domain object or the API. The
// 'brand' kind (#15) holds group skinning images, keyed by slot.
export type ImageOwnerKind = 'cms' | 'member' | 'listing' | 'brand';

/** Group skinning slots (#15): brand images' ownerId names the slot. */
export type BrandSlot = 'logo' | 'header';

export interface Image {
  id: Id;
  groupId: Id;
  ownerKind: ImageOwnerKind;
  ownerId?: Id; // absent for cms images; member/listing id otherwise
  mime: string;
  size: number; // bytes
  createdBy: Id;
  createdAt: string;
}

// Audit trail (data-model §8): admin actions, MCP token grants/revocations,
// and lifecycle transitions. Append-only — events are only ever added.
export interface AuditEvent {
  id: Id;
  groupId?: Id; // absent for platform-level (operator) events
  actorUserId?: Id; // absent for system/lifecycle events
  actingForMemberId?: Id; // login-as/proxy (§8), reserved
  action: string; // dotted, e.g. 'member.approve', 'token.issue'
  entityType: string; // e.g. 'member', 'transaction', 'api_token'
  entityId: Id;
  detail?: Record<string, unknown>; // free-form action context
  at: string;
}

export interface StatementLine {
  seq: number;
  transactionId: Id;
  type: TxType;
  description?: string;
  reference?: string;
  amount: number; // this account's leg
  runningBalance: number;
  committedAt: string;
}

export interface VerifyReport {
  ok: boolean;
  errors: string[]; // balance mismatches, chain breaks, seq/chain divergence
}


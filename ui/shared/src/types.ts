// Hand-written response types, copied faithfully from the server's actual
// responses (server/src/api/app.ts and server/src/types.ts). The server's
// Fastify route schemas declare request bodies but almost no response
// schemas, so openapi-typescript generates `content?: never` for every
// response — request/path types come from the generated src/api-types.d.ts,
// response shapes live here until the server grows response schemas.

export type Id = string;

// --- Domain enums (server/src/types.ts) ------------------------------------

export type TxType =
  | 'trade'
  | 'demurrage'
  | 'fee'
  | 'settlement'
  | 'reversal'
  | 'adjustment';

export type TxState = 'pending' | 'committed' | 'declined' | 'cancelled' | 'expired';

export type TxFlow = 'payment' | 'invoice';

export type Channel = 'web' | 'mcp' | 'admin' | 'system';

export type MemberStatus = 'applied' | 'active' | 'away' | 'suspended' | 'closed';
export type MemberType = 'individual' | 'joint' | 'organisation';
export type MemberRole = 'member' | 'committee' | 'admin';

export type CreditPolicyType = 'soft_threshold' | 'hard_limit';

export type ListingType = 'offer' | 'want';
export type ListingStatus = 'active' | 'hidden' | 'expired';

// --- Entities as the API returns them --------------------------------------

export interface Group {
  id: Id;
  slug: string;
  name: string;
  createdAt: string;
}

export interface Currency {
  id: Id;
  groupId: Id;
  code: string;
  name: string;
  scale: number;
  demurrageDay?: number;
  createdAt: string;
}

/** Full member record (own /me, and admin listings). */
export interface Member {
  id: Id;
  groupId: Id;
  memberNo: number;
  type: MemberType;
  role: MemberRole;
  displayName: string;
  status: MemberStatus;
  confirmIncoming: boolean;
  appliedAt: string;
  approvedAt?: string;
  closedAt?: string;
}

/** Directory projection: public profile fields only (GET /members). */
export interface DirectoryMember {
  id: Id;
  memberNo: number;
  displayName: string;
  type: MemberType;
  status: MemberStatus;
}

/** Trade-count profile stats (decision #8), returned by GET /members/:id. */
export interface TradeStats {
  trades: number;
  partners: number;
  lastTradeAt?: string;
}

export interface Entry {
  id: Id;
  transactionId: Id;
  accountId: Id;
  amount: number; // signed, minor units
}

export interface Transaction {
  id: Id;
  groupId: Id;
  type: TxType;
  flow?: TxFlow;
  state: TxState;
  seq?: number;
  hash?: string;
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

/** A pending transaction from this member's point of view (decision #5). */
export interface PendingItem {
  id: Id;
  type: TxType;
  flow?: TxFlow;
  amount: number; // absolute amount of this member's leg
  direction: 'in' | 'out';
  description?: string;
  expiresAt?: string;
  actions: ('accept' | 'decline' | 'cancel')[];
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

/** One account in the GET /me response, balance included. */
export interface AccountSummary {
  id: Id;
  currencyId: Id;
  currencyCode: string;
  balance: number;
}

/** GET /me response. */
export interface Me {
  member: Member;
  accounts: AccountSummary[];
}

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
  priceAmount?: number;
  priceCurrencyId?: Id;
  rateText?: string;
  status: ListingStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Credit control (decision #3) -------------------------------------------

export interface SoftThreshold {
  balance: number;
  level: string;
}

export interface CreditPolicyConfig {
  thresholds?: SoftThreshold[]; // soft_threshold
  minBalance?: number; // hard_limit (max debit)
  maxBalance?: number; // hard_limit (max credit)
}

export interface Policy {
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

/** GET /admin/flags item (computed, never blocking by itself). */
export interface Flag {
  accountId: Id;
  memberId: Id;
  level: string;
  reason: string;
}

// --- Demurrage (decision #1) -------------------------------------------------

export interface DemurrageBand {
  fromAmount: number; // band start, minor units
  ratePpmPerMonth: number; // marginal rate, parts-per-million per month
}

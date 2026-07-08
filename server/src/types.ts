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

// Membership (decision #7).
export type MemberStatus = 'applied' | 'active' | 'away' | 'suspended' | 'closed';
export type MemberType = 'individual' | 'joint' | 'organisation';

export interface Member {
  id: Id;
  groupId: Id;
  memberNo: number; // per-group sequential, human-friendly
  type: MemberType;
  displayName: string;
  status: MemberStatus;
  confirmIncoming: boolean; // opt-in payment confirmation (decision #5)
  appliedAt: string;
  approvedAt?: string;
  closedAt?: string;
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


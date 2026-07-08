// Pluggable storage interface (decision #6 and specs/data-model.md).
// The ledger contract: post/transition are atomic; balances always equal the
// sum of committed entries; whether they are derived or cached is the
// implementation's private decision.

import type {
  Account,
  AccountType,
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
  Group,
  Id,
  Listing,
  ListingStatus,
  ListingType,
  Member,
  MemberStatus,
  MemberType,
  NewTransaction,
  Person,
  Restriction,
  StatementLine,
  TradeStats,
  Transaction,
  TxState,
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
  imposeRestriction(memberId: Id, reason: string, imposedBy: Id): Promise<Restriction>;
  liftRestriction(memberId: Id, liftedBy: Id): Promise<void>;
  activeRestriction(memberId: Id): Promise<Restriction | undefined>;

  /** Pending transactions with expiresAt <= asOf (decision #5 sweeps). */
  pendingDue(groupId: Id, asOf: string): Promise<Transaction[]>;
  /** Pending transactions with a leg on any of the member's accounts. */
  pendingForMember(memberId: Id): Promise<Transaction[]>;
  /** Trade-count stats from committed 'trade' transactions (decision #8). */
  tradeStats(memberId: Id): Promise<TradeStats>;

  // Marketplace.
  createCategory(input: { groupId: Id; name: string; parentId?: Id }): Promise<Category>;
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

  close(): void;
}

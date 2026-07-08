// Pluggable storage interface (decision #6 and specs/data-model.md).
// The ledger contract: post/transition are atomic; balances always equal the
// sum of committed entries; whether they are derived or cached is the
// implementation's private decision.

import type {
  Account,
  AccountType,
  Currency,
  DemurrageBand,
  DemurrageRun,
  Group,
  Id,
  NewTransaction,
  StatementLine,
  Transaction,
  TxState,
  VerifyReport,
} from './types.js';

export interface CreateGroupInput {
  slug: string;
  name: string;
}

export interface CreateCurrencyInput {
  groupId: Id;
  code: string;
  name: string;
  scale?: number; // default 0
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

  close(): void;
}

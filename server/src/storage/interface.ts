// Pluggable storage interface (decision #6 and specs/data-model.md).
// The ledger contract: post/transition are atomic; balances always equal the
// sum of committed entries; whether they are derived or cached is the
// implementation's private decision.

import type {
  Account,
  AccountType,
  Currency,
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
  close(): void;
}

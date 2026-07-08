// Domain types for the storage layer, from specs/data-model.md.
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

// --- Errors -----------------------------------------------------------------

export type StorageErrorCode =
  | 'UNBALANCED' // legs of some currency do not sum to zero (decision #6)
  | 'INVALID_TRANSACTION' // < 2 legs, zero/non-integer amounts, bad refs
  | 'CROSS_GROUP' // a leg's account belongs to another group (decision #2)
  | 'INVALID_TRANSITION' // not a legal #5 state-machine edge
  | 'NOT_FOUND';

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

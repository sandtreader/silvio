// Storage-specific errors: typed failures of the ledger contract.

export type StorageErrorCode =
  | 'UNBALANCED' // legs of some currency do not sum to zero (decision #6)
  | 'INVALID_TRANSACTION' // < 2 legs, zero/non-integer amounts, bad refs
  | 'CROSS_GROUP' // a leg's account belongs to another group (decision #2)
  | 'INVALID_TRANSITION' // not a legal #5 state-machine edge
  | 'CONFLICT' // uniqueness violated, e.g. a duplicate page slug (#13)
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

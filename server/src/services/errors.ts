// Domain-service errors. Messages are member-facing: state the specific rule
// that blocked the action (decision #3 — opaque failures poison trust).

export type DomainErrorCode =
  | 'INVALID' // bad input (amount, missing fields)
  | 'NOT_FOUND'
  | 'WRONG_STATE' // action not valid for the member/transaction state
  | 'NOT_AUTHORISED' // actor may not perform this action
  | 'RESTRICTED' // outward payments blocked by admin restriction (decision #3)
  | 'SUSPENDED' // member is suspended (decision #7)
  | 'GROUP_SUSPENDED' // group is suspended: read-only (decision #20)
  | 'LIMIT_BREACHED' // hard credit limit (decision #3)
  | 'RATE_LIMITED'; // too many failed login attempts

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

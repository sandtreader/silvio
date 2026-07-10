# Plan: Intertrading — same-instance gateway pairs, then Credit Commons

Parked from [server/todo.md](../server/todo.md) Payments & ledger (phase 1)
and Later/speculative (Credit Commons, phase 2). Decisions referenced: #4
(federation — gateway model reserved), #2 (co-hosted groups), #5 (two-phase
states), #6 (remote_ref), #10 (chained hashes are what Credit Commons
expects).

## Why

Members of small LETS run out of counterparties; intertrading is how every
mature network solved it (CES gateway accounts, hOurworld's 400+ timebanks,
Credit Commons). Decision #2 noted the bonus: co-hosted groups on one SaaS
instance make intertrading "an internal transfer between gateway accounts
rather than a federation protocol problem" — #4 names same-instance
intertrading the natural first milestone.

## Current state

- Account type `gateway` exists (`types.ts` AccountType), exempt from
  demurrage (`ledger/demurrage.ts`, #1) and credit-control policies (#3).
- `accounts.counterparty_ref` (which external group/node) and
  `transactions.remote_ref` exist in the schema (#4/#6).
- Two-phase pending→committed state machine (#5) — the shape Credit
  Commons' create→validate→commit needs.
- Multi-currency ledger; `currencies.rate_ref` reserved *(planned)*, no
  rate logic anywhere.
- Tenancy invariant: all legs of a transaction stay in one group (#2, #6)
  — cross-group trades MUST be two transactions.

## Proposed design (phase 1: same instance)

- **Gateway pair**: linking groups A and B creates one gateway account in
  each group's currency space — in A: `gateway` account with
  counterparty_ref = B; in B: mirror with counterparty_ref = A. New table
  `gateway_pairs`: `id, group_a_id, group_b_id, currency_a_id,
  currency_b_id, rate?, trust_limit_a, trust_limit_b, status
  (proposed | active | suspended), created_at`.
- **Authorisation**: both groups' admins opt in — A's admin proposes
  (choosing local currency + limit), B's admin accepts. Operator never
  creates pairs unilaterally. Suspend/end by either side; audited.
- **Exchange rate**: v1 is **1:1 in minor units, fixed per pair at
  creation** (LETS units are mostly hour-anchored, and 1:1 is what CES
  intertrading de facto does). A per-pair fixed ratio (a:b integers, no
  floats) is cheap to allow at creation; *variable* rates are explicitly
  out — that's federation-phase machinery (#4's rate_ref).
- **A cross-group payment posts as two transactions, one per group,
  linked by remote_ref** (each carries the other's id): in A, payer →
  A-gateway; in B, B-gateway → payee. Committed atomically in application
  code: same process, same SQLite — post A's, post B's, and if B's fails,
  compensate A's (reversal, #5) — or hold both as pending and commit
  together; see open question. Each group's hash chain (#10) stays
  self-contained.
- **Trust limits per pair** (Tauschring rule: ~10% of scheme activity):
  a hard cap on the gateway account's absolute balance, checked at
  commit like a hard-limit policy (#3) with a specific deny reason
  ("intertrading limit with B reached"). Admin-editable per side.
- **Member UX**: payee picker gains a partner-group tab (searches B's
  directory at member visibility); statements show "→ Falmouth LETS:
  veg box (via gateway)" (#4's wording). Payee confirm-incoming and
  restrictions apply on each side as normal.

## Phase 2 pointer: Credit Commons federation (#4)

Cross-*instance* trading targets the Credit Commons protocol
(credit-commons.gitlab.io docs): tree of nodes, mirrored accounts,
chained hashes (we have them, #10), create→validate→commit (we have
pending→committed, #5). The phase-1 pair table becomes a local special
case of a remote node config; remote_ref carries the CC transaction id.
Not designed further here — protocol endpoints, retry/recovery, and
trunkward rate conversion are a separate spec when two real instances
want to talk.

## Implementation sketch (TDD slices)

1. Storage: `gateway_pairs` + gateway-account creation; migration.
2. Pair lifecycle: propose/accept/suspend admin routes + audit; tests.
3. Cross-group post: `services/intertrading.ts` posting the linked pair
   of transactions with compensation-on-failure; idempotency both sides;
   verify() green on both chains.
4. Trust-limit check at commit with deny reason.
5. Member surface: partner directory search, payment flow, statement
   labels.
6. (later) Credit Commons spec work.

## Open questions

- Atomicity model for the two posts: sequential-with-compensation, or
  both pending then committed together? (Same-process makes the latter
  tractable; compensation is what federation will need anyway.)
- Fixed non-1:1 ratios at pair creation — allow or forbid in v1?
- Can invoices (payee-initiated) cross the gateway in v1, or payments
  only?
- Directory visibility across the pair: full member visibility or an
  opt-in flag per member?

## Dependencies / parked until

Parked until the instance actually hosts two groups that want it (needs
two real communities, or it's speculation). Phase 2 additionally waits
on Merkle checkpoints (plan-checkpoints.md) for cross-witnessing and on
a partner instance.

Referenced from server/todo.md's parked list.

# Plan: Income ties — % of income to a chosen account

Parked from [server/todo.md](../server/todo.md) Payments & ledger. Decisions
referenced: #6 (multi-leg ledger — explicitly names "income-tie splits" as a
motivating case), #3 (credit control at commit).

## Why

Legacy Local Exchange feature (first-review): "member donates a
configurable % of any income to a chosen account (e.g. community fund),
processed on every trade." It's community fundraising and a voluntary
extra beyond demurrage (#1/#7's funding story) — CamLETS-style groups with
a cams treasury will want it. Decision #6 designed multi-leg transactions
partly *for* this: "income-tie splits (payment + % to community fund
atomically)".

## Current state

- Ledger supports ≥2 legs summing to zero per currency (#6;
  `storage/interface.ts` `post()`); nothing restricts trades to two legs.
- All commit paths flow through `services/trading.ts` (`sendPayment`,
  `accept` for invoices, QR `scan` #22) — one choke point to add legs.
- No per-member tithe config anywhere.

## Proposed design

- **Config per (member, currency)**: `income_ties` table — `id, member_id,
  currency_id, rate_ppm, target_account_id, created_at, ended_at?`. Rate
  in ppm (data-model convention). Target: v1 restricts to the currency's
  community account (removes an abuse surface — routing to an arbitrary
  member is just a standing order, different feature); open question below.
- **Member-set**, from the app (More → profile), because it's *their*
  income being tithed; admins can view. Admin-set-on-behalf only via the
  existing act-as proxy (#24) — no separate admin lever.
- **Applied at commit time** in the trading service, not in the ledger:
  when a `trade` commits and the payee has an active tie in that currency,
  the payment posts as one transaction with three legs: payer −A,
  payee +(A − tithe), community +tithe. Tithe = floor(A × rate_ppm / 1e6)
  (round down, in the member's favour — #1's rounding posture). Applies to
  payments, accepted invoices, and QR scans alike (they share the commit
  path); NOT to demurrage/settlement/reversal types.
- **Why commit-time**: pending invoices carry the face amount; the tie in
  force *when the money moves* applies — same rule as credit-control (#3).
- **Credit limits**: the payer's exposure is unchanged (−A either way);
  the payee's credited amount is smaller, which only helps credit-side
  thresholds. Authorisation hooks see the real legs — nothing special.
- **Statements**: the payee's statement shows +A−t with the trade, and the
  tithe leg visible in the transaction detail ("of which X to Community");
  the payer sees −A exactly as today. Reversal of a tied trade reverses
  all three legs (compensating tx already copies legs).
- **Display**: member profile shows the active tie ("You give 5% of income
  to the Community fund"); the transaction detail view lists all legs —
  already true of multi-leg txs.

## Implementation sketch (TDD slices)

1. Storage: `income_ties` table + get/set on Storage; migration.
2. Trading: commit-path leg injection (one pure function
   `applyIncomeTie(legs, tie)` + wiring in `sendPayment`/`accept`/`scan`);
   tests: rounding, zero-rate, no-tie, reversal round-trip, invoice
   accepted after tie changed.
3. API: `GET/PUT /me/income-tie` (per currency); audit event on change.
4. Member app UI: setting + statement rendering of the split.
5. Admin visibility: tie column on the member detail page.

## Open questions

- Target account: community-only (v1 lean) or any account in the currency
  (true legacy parity — enables member-to-member ties)?
- Cap the rate (e.g. ≤ 20%) to keep a fat-fingered 100% from zeroing all
  income?
- Does a tie apply to *incoming* QR/stall payments where the payee minted
  a fixed-amount request expecting the face value?  (Consistency says yes;
  merchant expectations say maybe warn at mint time.)
- Group toggle to enable the feature at all, or always available?

## Dependencies / parked until

None — the ledger is ready (that was #6's point). Parked as
nice-to-have until a pilot group asks; cheap to build when they do.

Referenced from server/todo.md's parked list.

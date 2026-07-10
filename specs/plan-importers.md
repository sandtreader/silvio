# Plan: Migration importers — Mutual Credit Manager & Local Exchange

Parked from [server/todo.md](../server/todo.md) Operator & deployment.
Decisions referenced: #2 (provisioning), #6 (zero-sum ledger), #7 (no fees).
Evidence: [first-review.md](first-review.md) — Falmouth LETS runs MCM,
CamLETS runs the LETSlink legacy platform; these are the likely first
adopters, and "migration-in-a-day importers" is what let hOurworld grow.

## Why

Nobody adopts a new LETS platform by retyping 200 members. First-review
§4.4: "CSV/DB import of members, balances, listings from MCM and Local
Exchange installs — the likely first adopters run them." A credible import
path is the adoption feature.

## Current state

- Operator provisioning exists: `services/provisioning.ts`
  `provisionGroup()` (slug, name, currency, initial admin) + operator
  console (`ui/operator`, #21).
- Full API for everything an import needs to create: members, persons,
  listings, categories; ledger `post()` with idempotency keys (#6).
- No import tooling of any kind.

## What each source exposes

- **MCM** (PHP/Slim 3/MySQL, GPL, github.com/cdmweb/mutualcreditmanager):
  MySQL dump. Members (with joint members, holiday mode, photos, roles),
  categories, offers/wants, transactions, CMS pages, balances. Single
  group per install.
- **Local Exchange UK** (PHP4/MySQL, github.com/cdmweb/Local-Exchange-UK):
  MySQL dump; schema warts documented in first-review (login-string PKs,
  char(1) enums, denormalised balance column — treat the *computed*
  balance from trades as truth, cross-check against the stored column,
  report discrepancies rather than trust either silently).
- Practical input format: **operator runs `mysqldump` and we parse the
  dump** (or CSV exports where an operator can't get a dump). Start with
  dump parsing for MCM (active, known schema), CSV as the LE fallback.

## Proposed design

- **Scope imported**: members + persons (names, emails, joint members,
  member_no preserved where possible), categories, active listings,
  **balances as opening adjustments**. Explicitly NOT imported:
  transaction history (summarised as one opening balance per member),
  feedback/ratings (rejected, #8), fees machinery (#7 has none), CMS
  pages/photos (v1: manual; revisit).
  Trade-off stated honestly: members lose their visible history; the
  source system's final statement should be archived (the dump itself is
  the archive).
- **Opening balances in a zero-sum ledger (#6)**: one multi-leg
  `adjustment` transaction per currency — a leg per member at their
  opening balance, offset by a single balancing leg on a **system account
  `migration`** (type `system`, not the community account: the community
  account's history is socially meaningful (#7) and shouldn't carry a
  giant artificial leg). The migration account's balance is then the
  negated sum of imported balances — zero iff the source summed to zero;
  a nonzero residue is visible forever, which is honest. Legs sum to
  zero per currency by construction; hash chain starts clean.
- **Idempotent re-runs**: every created entity keyed by a deterministic
  source ref (e.g. idempotency key `import:{source}:{table}:{pk}`;
  members matched on member_no/email). Re-running after a partial
  failure completes rather than duplicates.
- **Dry-run first**: `--dry-run` produces a report — counts per entity,
  balance total (must be ~0), unmappable rows, duplicate emails, members
  with no email (imported as offline persons, #23) — for the group
  committee to sign off before the real run.
- **Delivery: CLI first** (`scripts/import-mcm.ts` run by the operator on
  the server against the dump file), operator-console upload later if
  SaaS demand appears. CLI is testable, restartable, and matches the
  operator-driven migration-day reality.
- Users get invite emails (#23 invite tokens) rather than imported
  password hashes (unsalted SHA1 in LE — never migrate those).

## Implementation sketch (TDD slices)

1. Fixture dumps: a small MCM schema fixture + expected import result;
   tests drive the mapper.
2. Mapper: MCM tables → Silvio API-shaped records (pure functions, no IO).
3. Opening-balance builder: balances → one adjustment tx per currency +
   migration system account; test zero-sum + idempotency.
4. CLI runner: dry-run report, then execute via services (not raw SQL) so
   invariants/audit apply; resume-safe.
5. Local Exchange variant: reuse the pipeline, source-specific mapper,
   balance cross-check (stored column vs computed).

## Open questions

- Import transaction history after all (as committed trades with original
  timestamps)? Doable — chain hashes at import time — but bloats scope;
  default no.
- Preserve source member numbers as member_no, or renumber?
- Do imported members start `active` without re-consenting to the new
  agreement/GDPR text, or land in a "confirm on first login" state?
- MCM photos/CMS pages: worth automating, or migration-day manual?

## Dependencies / parked until

Parked until a real group commits to migrating (Falmouth/CamLETS
conversations) — their actual dump decides fixture truth. No code
dependencies; #23 (invites) already shipped.

Referenced from server/todo.md's parked list.

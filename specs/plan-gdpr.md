# Plan: GDPR — anonymise-on-exit + data export

Parked from [server/todo.md](../server/todo.md) Membership & identity.
Decisions referenced: #7 (data on exit), #6 (append-only journal), #10 (hash
chain).

## Why

Decision #7 promises it: "member/user records are anonymised after a
retention window; accounts persist as anonymous ledger counterparties.
Satisfies GDPR erasure without breaking audit-to-zero." First-review §4.4
lists GDPR consent, export and delete as baseline. Consent at application
exists; erasure and export do not.

## Current state

- Leave/remove flow (`services/membership.ts` `leave()`): settles residual
  balance to the community account (`settlement` transaction), closes
  accounts, member status → closed. Personal data is untouched.
- `members.anonymised_at` is a *(planned)* marker in data-model §1.
- **Hash chain is anonymisation-safe — verified in `ledger/hash.ts`**:
  hash_version 1 covers `{v, prev, id, groupId, type, seq, committedAt,
  entries:[accountId, amount]}` only. Names never enter the chain, and
  `description`/`reference` are deliberately NOT hashed. So scrubbing text
  fields cannot break `verify()`.
- One wrinkle: `leave()` writes `description: "Leaver settlement for
  {displayName}"` — a name embedded in an (immutable-by-discipline)
  transaction row. Since description is outside the hash, redaction is
  *possible*; it needs an explicit, narrow carve-out from the #6
  append-only rule (see below).
- Statement CSV export exists (`GET /me/statement.csv`) — a piece of the
  export story already shipped.

## Proposed design

- **Retention window**: group setting `anonymiseAfterDays` (default 365?)
  via the existing `group.settings` JSON + `services/settings.ts` defaults.
  Clock starts at `members.closed_at`. Also applies to rejected
  applications (decision #7 says purged after a retention window — shorter,
  e.g. 90 days?).
- **What anonymising means, per table** (member + their persons/users):
  - `members`: display_name → "Former member #\{member_no\}", about/
    neighbourhood/photo cleared, `anonymised_at` set.
  - `persons`: name → placeholder, email/phones/address nulled.
  - `users`: only if this was their last non-closed membership — email →
    tombstone (`deleted+{uuid}@invalid`, keeps the unique constraint),
    password_hash cleared, status → closed, sessions/api_tokens revoked.
  - `listings`: already purged by shelf-life sweep (#18); force-purge any
    stragglers + their photos.
  - `images`: member-owner rows deleted.
  - `email_events`: rows for the person hard-deleted after anonymisation
    (they hold addresses and bodies).
  - `audit_events`: append-only, kept — but `detail` json may embed names;
    decide whether to scrub detail fields or accept audit as a lawful-basis
    retention (leaning: keep, it's a legitimate-interest security log —
    confirm).
  - **`transactions.description/reference` redaction**: replace occurrences
    tied to the member (at minimum the settlement description) with a
    neutral string. Amend decision #6's wording: append-only applies to
    financial facts (legs, amounts, states, chain); descriptive text is
    redactable for erasure, chain unaffected.
- **What's deliberately kept**: ledger rows, accounts (anonymous
  counterparties), audit trail, aggregate stats. Counterparties' statements
  keep working — they just show the anonymised display name.
- **Member self-export**: `GET /me/export` → JSON bundle: user + person
  profile, member record, accounts + full statement, listings, api tokens
  (metadata), email_events addressed to them. Available any time, not just
  at exit. Photos as image ids or inline base64? (leaning ids + separate
  fetch).
- **Scheduler sweep**: new step in `services/scheduler.ts` tick — find
  closed members past the window, anonymise idempotently (anonymised_at
  guards re-runs), audit-log `member.anonymise` per member.

## Implementation sketch (TDD slices)

1. Storage: `anonymiseMember(memberId)` on the Storage interface — one
   transaction covering all tables above; test that verify() still passes
   afterwards and balances are unchanged.
2. Settings: `anonymiseAfterDays` (+ rejected-application purge window).
3. Scheduler sweep + audit events; idempotency tests.
4. `GET /me/export` JSON; test completeness against every personal-data
   table.
5. Redaction carve-out: storage method to scrub description/reference on
   named transactions; decisions.md amendment noted for a human to ratify.

## Open questions

- Default retention window (365d? statutory-ish 6y for "financial
  records"? — groups aren't companies; a human call).
- Audit_events: scrub detail json or retain as legitimate interest?
- On-demand erasure (member requests immediate anonymisation while window
  runs) — admin button, or wait for the sweep?
- Export: include counterparty display names in the statement (their data)
  or member's own legs only?

## Dependencies / parked until

None technical. Parked awaiting a pilot group (and their data-protection
appetite) to set the retention defaults. The decisions.md #6 wording
amendment needs explicit sign-off.

Referenced from server/todo.md's parked list.

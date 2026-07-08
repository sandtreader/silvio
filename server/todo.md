# Server TODO

Remaining server-side work, grouped by area. References are to
[specs/decisions.md](../specs/decisions.md) (#n) and
[specs/data-model.md](../specs/data-model.md).

## MCP server (#9)

- [ ] `api_tokens` storage: hashed tokens, scopes, per-token spend caps, expiry,
      last-used (data-model §7)
- [ ] Bearer-token auth path alongside cookie sessions (same routes, same guards)
- [ ] Scope enforcement: `marketplace:read`, `directory:read`, `account:read`,
      `listings:write`, `trade:request`, `trade:autonomous`
- [ ] `trade:request` payments land `pending` for web confirmation (#5 reuse);
      `trade:autonomous` bounded by per-token caps computed from the journal
- [ ] Token management routes (member creates/labels/revokes own tokens)
- [ ] The MCP server itself: tools for marketplace/directory query, statement,
      payment/invoice creation

## Payments & ledger

- [ ] QR/EPOS payload: signed {payee, amount, reference} + `POST /payments` from
      scanned payload with idempotency key (plan.md; #5: it's an invoice)
- [ ] Merkle checkpoints + inclusion proofs (#10, parked) and Witness plugins
      (newsletter/digest/git/peer-group); `verify` extension
- [ ] Scheduled `verify()` job with loud alerting (#6 — no silent option)
- [ ] Statement pagination + CSV export
- [ ] Income ties (% of income to a chosen account — legacy feature, multi-leg
      support already in the ledger)
- [ ] Same-instance intertrading via paired gateway accounts (#4 first milestone)

## Membership & identity

- [ ] Password reset + email verification (`one_time_token`, data-model §1)
- [ ] Passkeys/WebAuthn + 2FA (deferred from API slice)
- [ ] Login lockout / rate limiting on auth endpoints
- [ ] CSRF protection for cookie sessions (or SameSite=strict + origin check)
- [ ] Joint members: persons CRUD API (add/remove person on a membership)
- [ ] GDPR: anonymise-on-exit after retention window (#7); data export
- [ ] Proxy/buddy: admin acts-for-member ("login as") with audit trail (#2)
- [ ] Member photos (blob storage, size/count limits — storage-layer decision)

## Email & notifications

- [ ] Outbound email infrastructure (SMTP config, `email_event` log, dedup)
- [ ] Transactional: welcome/approval, invoice received, payment held/received,
      accepted/declined, expiry warnings, restriction imposed/lifted
- [ ] Offers & wants digest per member frequency (weekly/monthly/never) —
      scheduler job; `member.digestFrequency` exists but is unused
- [ ] Admin broadcast (email all members)

## Admin & governance

- [ ] Audit-event log (data-model §8): admin actions, MCP grants, lifecycle
      transitions — append-only, surfaced via `GET /admin/audit`
- [ ] Dashboard stats endpoints (plan.md): balance distribution, currency flow
      over time, velocity, dormancy
- [ ] Demurrage projection ("if unspent, ~X on the 1st") for member dashboard (#1)
- [ ] Group transparency settings + `GET /balances` view (#3; CamLETS publishes
      balances/turnover)
- [ ] Listing auto-expiry for inactive members (warning email → expire → purge;
      reference-standard)
- [ ] Group settings surface: auto-accept days, invoice expiry days, digest
      defaults (currently hard-coded constants in trading service)
- [ ] Demurrage run history route (`GET /admin/runs`)

## Marketplace

- [ ] Generic search (FTS5) over listings/directory per data-model Search
      interface, visibility-tiered
- [ ] Listing photos (SQLite blobs, limits)
- [ ] Category admin routes (create/edit/delete, recategorise)
- [ ] Location/neighbourhood field + directory filtering (CamLETS grid pattern)
- [ ] Qualified/professional flags on listings (#8 — admin-verified badges)

## Operator & deployment

- [ ] Operator group management: suspend group, edit domains, plan/status field
- [ ] Migration importers: members/balances/listings from Mutual Credit Manager
      and Local Exchange installs (first-review — likely first adopters)
- [ ] Backup story (SQLite online backup + restore procedure)
- [ ] Config file alternative to env vars; structured logging
- [x] Demo script: scripts/demo.sh — full lifecycle end-to-end (listings/history seeding still open)
- [ ] Deployment guide for the minimal-VPS target (#7); systemd unit / Docker
- [ ] CORS configuration for the UI origin

## Later / speculative

- [ ] Credit Commons federation (#4)
- [ ] Passkey-signed payment authorisations (non-repudiation, #10)
- [ ] Optional private-feedback plugin (#8 — only if a group demands it)
- [ ] i18n

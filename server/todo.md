# Server TODO

Remaining server-side work, grouped by area. References are to
[specs/decisions.md](../specs/decisions.md) (#n) and
[specs/data-model.md](../specs/data-model.md).

## MCP server (#9)

- [x] `api_tokens` storage: hashed tokens, scopes, per-token spend caps, expiry,
      last-used (data-model §7)
- [x] Bearer-token auth path alongside cookie sessions (same routes, same guards;
      routes opt in via config.scopes, everything else stays cookie-only)
- [x] Scope enforcement: `marketplace:read`, `directory:read`, `account:read`,
      `listings:write`, `trade:request`, `trade:autonomous`
- [x] `trade:request` payments land `pending` for web confirmation (#5 reuse);
      `trade:autonomous` bounded by per-token caps computed from the journal
- [x] Token management routes (member creates/labels/revokes own tokens)
- [x] The MCP server itself: Streamable HTTP at {tenancy}/mcp, stateless,
      tools filtered by scope, thin client of the REST API via inject
- [ ] Per-token request rate limiting (decision #9 mentions it; LoginThrottle
      is reusable)
- [ ] Token management UI in the member PWA (routes exist, no screen yet)
- [ ] Agents cannot accept/decline/cancel pending transactions (cookie-only
      by design — accepting stays a human act); revisit whether an agent may
      cancel its own unconfirmed proposals

## Payments & ledger

- [ ] QR/EPOS payload: signed {payee, amount, reference} + `POST /payments` from
      scanned payload with idempotency key (plan.md; #5: it's an invoice)
- [ ] Merkle checkpoints + inclusion proofs (#10, parked) and Witness plugins
      (newsletter/digest/git/peer-group); `verify` extension
- [x] Scheduled `verify()` job with loud alerting (#6 — every tick verifies
      every group; failures alert via console.error by default)
- [ ] Statement pagination + CSV export
- [ ] Income ties (% of income to a chosen account — legacy feature, multi-leg
      support already in the ledger)
- [ ] Same-instance intertrading via paired gateway accounts (#4 first milestone)

## Membership & identity

- [ ] Password reset + email verification (`one_time_token`, data-model §1)
- [ ] Passkeys/WebAuthn + 2FA (deferred from API slice)
- [x] Login lockout / rate limiting on auth endpoints (sliding window: 10
      failures/15 min per email, 30 per IP; 429 + Retry-After)
- [x] CSRF protection for cookie sessions (SameSite=lax + Origin check on
      state-changing /api/* requests)
- [ ] Joint members: persons CRUD API (add/remove person on a membership)
- [ ] GDPR: anonymise-on-exit after retention window (#7); data export
- [ ] Proxy/buddy: admin acts-for-member ("login as") with audit trail (#2)
- [x] Member photos — done via Image store phase 2 (#14) under Content

## Email & notifications

- [x] Outbound email infrastructure (SMTP config via SILVIO_SMTP_URL/_EMAIL_FROM,
      `email_events` queue + log, dedup keys, retry with 3-attempt cap,
      background delivery loop)
- [x] Transactional: welcome/approval, invoice received, payment held/received,
      accepted/declined, auto-accept/invoice-expiry, restriction imposed/lifted
      (no member notification preferences yet — everyone with an email gets them)
- [ ] Offers & wants digest per member frequency (weekly/monthly/never) —
      scheduler job; `member.digestFrequency` exists but is unused
- [ ] Admin broadcast (email all members)

## Content, brochure site & CMS-lite (#12, data-model §6, first-review)

- [x] `page` storage + API: slug, title, body (markdown, #13), visibility
      (public | members | admin), position; admin CRUD, visibility-tiered
      brochure rendering at /p/{slug} via markdown-it (html:false, images off
      until the group image store exists); reserved slug `home` overrides the
      placeholder front page and stays out of the nav
- [x] `news_item` storage + API: admin CRUD, published/expires window,
      markdown body (#13); brochure noticeboard at /news (public — news has
      no visibility tiers)
- [x] Image store phase 1 (#14): `images` table + `GET /i/{id}` (immutable
      cache headers), CMS admin upload/list/delete with markdown snippet,
      markdown-it image allowlist for `/i/` sources only, magic-byte + size
      + quota validation (client resizes before upload)
- [x] Image store phase 2 (#14): member profile photo (single,
      upload-replaces, 256KB) in member app + directory
- [x] Image store phase 3 (#14): listing photos (≤5, 1MB each) in app
      market + brochure
- [x] Brochure site at `/` (#12): server-rendered placeholder (group name
      header, welcome copy, public market browse, session-aware log-in/open-app
      link) — pages/news rendering waits on the CMS tables above
- [x] App-in-shell serving (#12): member app at `/app/` (base, basename,
      manifest start_url/scope), shell chrome injected server-side and hidden
      in standalone display mode; logged-out public market removed from the
      app; SW precaches only the app bundle
- [x] Shell chrome on app routes (#15, resolving the gap in
      [ui/shell-chrome.md](../ui/shell-chrome.md)): the app renders its own
      chrome from the public session-aware `GET /shell`; server-side
      injection into the app's index.html dropped
- [x] Group skinning (#12/#15): logo + header background image as `brand`
      images (one per slot, replace-on-upload), admin Branding page,
      rendered on the brochure shell and the app's client chrome
- [x] Group-editable email templates + per-group sender address (#16):
      per-kind markdown overrides with {{placeholder}} substitution, admin
      editor with live preview, multipart delivery (markdown text + rendered
      HTML), `group.emailFrom` snapshotted onto queued events

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
- [x] Listing photos — done via Image store phase 3 (#14) under Content
- [ ] Category admin routes (create/edit/delete, recategorise)
- [ ] Location/neighbourhood field + directory filtering (CamLETS grid pattern)
- [ ] Qualified/professional flags on listings (#8 — admin-verified badges)

## API polish

- [x] Response schemas in route definitions (all routes now declare response
      schemas — components.schemas covers every entity plus a shared
      ErrorResponse — and ui/shared derives its types from the generated
      OpenAPI types instead of hand-writing them).
- [x] Group currencies endpoint (public GET /currencies, mirroring
      /categories; admin UI currency pickers now use it instead of /me)
- [x] Expose currency scale in /me accounts
- [x] Transaction list/search for admins (GET /admin/transactions with
      member/currency/type/state/text filters and limit/offset paging;
      storage listTransactions returns full transactions plus a total)
- [x] List active restrictions (impose/lift exist; no read)
- [x] Categories API (admin create/rename; public read existed)

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
- [ ] Events calendar (first-review reference-standard; needs a data-model
      decision first)
- [ ] Passkey-signed payment authorisations (non-repudiation, #10)
- [ ] Optional private-feedback plugin (#8 — only if a group demands it)
- [ ] i18n

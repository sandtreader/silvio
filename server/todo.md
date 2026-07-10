# Server TODO

Remaining server-side work, grouped by area. References are to
[specs/decisions.md](../specs/decisions.md) (#n) and
[specs/data-model.md](../specs/data-model.md).

**Status 2026-07-10: feature-complete to current level.** Every unticked
item below is deliberately **parked** — big pieces waiting on a pilot
group or a real SaaS need to shape them (passkeys, GDPR, importers,
income ties, intertrading, Merkle/witness, and the Later section), not
loose ends. The tidy-up pass closed everything smaller.

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
- [x] Per-token request rate limiting (decision #9 mentions it; LoginThrottle
      is reusable)
- [x] Token management UI in the member PWA: /tokens page (More → API tokens)
      lists/creates/revokes; raw value shown once, caps at the account scale
- [ ] Agents cannot accept/decline/cancel pending transactions (cookie-only
      by design — accepting stays a human act); revisit whether an agent may
      cancel its own unconfirmed proposals

## Payments & ledger

- [x] QR/EPOS payload: signed {payee, amount, reference} + `POST /payments` from
      scanned payload with idempotency key (plan.md; #5: it's an invoice) —
      #22: server-minted HMAC payloads (per-group secret), mint/decode/scan
      endpoints; scans commit without a confirm-incoming hold
- [ ] Merkle checkpoints + inclusion proofs (#10, parked) and Witness plugins
      (newsletter/digest/git/peer-group); `verify` extension
- [x] Scheduled `verify()` job with loud alerting (#6 — every tick verifies
      every group; failures alert via console.error by default)
- [x] Statement pagination + CSV export (newest-first pages with a total,
      window-function running balances; `GET /me/statement.csv` downloads
      the whole history oldest-first at the currency's scale; Activity page
      pages and links the download)
- [ ] Income ties (% of income to a chosen account — legacy feature, multi-leg
      support already in the ledger)
- [ ] Same-instance intertrading via paired gateway accounts (#4 first milestone)

## Membership & identity

- [x] Password reset + email verification (`one_time_tokens`, data-model §1:
      single-use hashed tokens, /auth/forgot|reset|verify, throttled forgot,
      reset revokes sessions; verification is recorded on the user only —
      nothing enforces it yet)
- [ ] Passkeys/WebAuthn + 2FA (deferred from API slice)
- [x] Login lockout / rate limiting on auth endpoints (sliding window: 10
      failures/15 min per email, 30 per IP; 429 + Retry-After)
- [x] CSRF protection for cookie sessions (SameSite=lax + Origin check on
      state-changing /api/* requests)
- [x] Joint members: persons CRUD API (#23: GET/POST/DELETE /me/persons,
      invite emails + POST /auth/accept-invite, last-person guard, access
      revocation on removal, individual->joint auto-typing)
- [ ] GDPR: anonymise-on-exit after retention window (#7); data export
- [x] Proxy/buddy: admin acts-for-member with audit trail (#24: act-as/
      stop-acting on the admin's own session, escalation blocked while
      acting; member-appointed buddies remain future)
- [x] Member photos — done via Image store phase 2 (#14) under Content

## Email & notifications

- [x] Outbound email infrastructure (SMTP config via SILVIO_SMTP_URL/_EMAIL_FROM,
      `email_events` queue + log, dedup keys, retry with 3-attempt cap,
      background delivery loop)
- [x] Transactional: welcome/approval, invoice received, payment held/received,
      accepted/declined, auto-accept/invoice-expiry, restriction imposed/lifted
      (no member notification preferences yet — everyone with an email gets them)
- [x] Offers & wants digest per member frequency (#17) — `member.digestFrequency`
      ('none' | 'weekly' | 'monthly', default weekly, set via PATCH /me; it did
      not exist before, it does now), scheduler tick sweeps per group, 'digest'
      email template kind, per-period dedup (digest:{period}:{person})
- [x] Admin broadcast (#17) — POST /admin/broadcast {subject, body}: one
      markdown email per person on every active membership, kind 'broadcast'
      (deliberately not a template kind), unique dedup per call

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

- [x] Audit-event log (data-model §8): admin actions, MCP grants, lifecycle
      transitions — append-only `audit_events` (no update/delete methods),
      never-throwing `recordAudit` helper, dotted actions across admin/token/
      application routes, surfaced via `GET /admin/audit`
- [x] Dashboard stats endpoints (plan.md): balance distribution, currency flow
      over time, velocity, dormancy — `GET /admin/stats?currencyId=` composing
      the `memberBalances`/`monthlyTradeFlow`/`lastTradeAt`/`tradeVolumeSince`
      storage aggregates via `services/stats.ts`
- [x] Demurrage projection ("if unspent, ~X on the 1st") for member dashboard
      (#1): /me accounts carry {amount, postingDate} computed with the real
      band engine; member Home shows the spend-it-forward caption
- [x] Group transparency settings + `GET /balances` view (#3; CamLETS publishes
      balances/turnover) — shipped as #19: `settings.transparency`
      ('none'/'balances', default 'none'), member-only `GET /balances`
      (balance + 12-month turnover, 404 when off); flag visibility stays
      future work with the credit-control flags
- [x] Listing auto-expiry for inactive members (warning email → expire → purge;
      reference-standard) — shipped as listing shelf life (#18): default expiry
      at post time (`listingMaxAgeDays`, 180), warning email 14 days out,
      `POST /listings/{id}/renew` resets/revives, purge 90 days after expiry
- [x] Group settings surface: auto-accept days, invoice expiry days, digest
      default for new members — `group.settings` JSON via PATCH /admin/group,
      effective defaults in services/settings.ts (transparency toggles from #3
      remain future)
- [x] Demurrage run history route (`GET /admin/runs`)

## Marketplace

- [x] Generic search (FTS5) over listings/directory per data-model Search
      interface, visibility-tiered
- [x] Listing photos — done via Image store phase 3 (#14) under Content
- [x] Category admin routes (create/edit/delete, recategorise)
- [x] Location/neighbourhood field + directory filtering (one free-text field,
      deliberately simpler than CamLETS's grid)
- [x] Qualified/professional flags on listings (#8 — admin-verified badges;
      PUT /admin/listings/:id/badges; shown in brochure market and member
      market. No admin UI yet — the API exists; the badge control belongs on
      a future listings-admin page)

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

- [x] Operator group management: suspend group, edit domains, plan/status field (#20)
- [ ] Migration importers: members/balances/listings from Mutual Credit Manager
      and Local Exchange installs (first-review — likely first adopters)
- [x] Backup story (SQLite online backup + restore procedure) — built-in job:
      daily integrity-checked copy, hourly check, 7-daily/4-Monday rotation;
      restore + off-site procedure in [deploy.md](../deploy.md)
- [x] Config file alternative to env vars; structured logging
- [x] Demo script: scripts/demo.sh — full lifecycle end-to-end, plus lived-in
      seeding: categories, listings, a month of trading history, public
      balances, about page and news item
- [x] Deployment guide for the minimal-VPS target (#7) — Docker image
      (root Dockerfile, GHCR publishing via .github/workflows/docker.yml) +
      [deploy.md](../deploy.md); no systemd unit — the container restart
      policy covers it
- [x] CORS configuration for the UI origin — not needed: everything is
      same-origin behind one hostname per group (see deploy.md); becomes a
      server feature only if a separately-hosted UI origin ever appears

## Later / speculative

- [ ] Credit Commons federation (#4)
- [ ] Events calendar (first-review reference-standard; needs a data-model
      decision first)
- [ ] Passkey-signed payment authorisations (non-repudiation, #10)
- [ ] Optional private-feedback plugin (#8 — only if a group demands it)
- [ ] i18n

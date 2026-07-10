# Silvio — Design Decisions

Decisions refined sequentially from the open list in
[first-review.md](first-review.md). Numbering follows that list.

## 1. Demurrage semantics — DECIDED 2026-07-08

Follow Gesell closely: demurrage is a holding charge on money, not a wealth tax on
debtors, and its purpose is velocity.

**Scope**
- Charged on **positive balances only**; negative balances are untouched.
- Proceeds posted to the **community account** of the same currency — funds admin
  work, server hosting, and community projects. This recycles the charge, so the
  currency stays zero-sum overall.
- Community/system accounts (and gateway accounts, if/when federation lands) are
  exempt. Suspended members' accounts are still charged while they remain open.

**Rate structure: marginal bands (tax-like)**
- Per-currency ordered list of bands: `[{ from_balance, marginal_rate_pct_per_month }]`.
- Applied marginally, like income tax: each slice of balance is charged at its
  band's rate. A first band at 0% acts as the free-base/grace threshold, so no
  separate grace-period mechanism is needed.
- Example: 0–100 @ 0%, 100–500 @ 1%/mo, 500+ @ 2%/mo → balance 600 pays
  0 + 4.00 + 2.00 = 6.00.
- Rates are politically sensitive (Leu voted theirs down 7×) — bands are ordinary
  admin-editable config, changes take effect from the next posting run.

**Cadence and accrual: monthly point-in-time snapshot**
- Posted **monthly** on a configurable day-of-month, computed on the **balance at
  posting time** — no time-weighted averaging.
- Rationale: this is the stamp-scrip model exactly (a stamp on whatever face value
  you hold on stamp day), it's trivially easy for members to understand ("if you
  haven't spent it by the 1st, it decays"), and "gaming" it by spending before the
  deadline is precisely the behaviour demurrage exists to induce — whoever holds
  the hot potato pays.
- **Accepted trade-off**: the collusive round-trip (park funds with a below-threshold
  or in-debit member over posting day, repaid after) escapes the charge. Mitigation
  is the existing transparency principle — all transactions are member-visible and a
  monthly month-end round-trip pattern is conspicuous; the dormancy/velocity reports
  can flag it. Not solving mechanically now. Keep the charge computation
  encapsulated (single function from (balance history, band config, period) →
  charge) so a time-weighted basis could be swapped in later without schema change.

**Mechanics**
- Each posting is an **ordinary ledger transaction** member → community account,
  typed `demurrage`, referencing the (currency, period) run — so the sum-to-zero
  audit always holds and statements show it like any other line.
- Idempotent runs: a demurrage run record per (currency, period); re-running a
  completed period is a no-op. Partial-failure recovery re-processes only unposted
  accounts in the run.
- Rounding: integer minor units; round each account's total charge **down** (in the
  member's favour).
- Members joining mid-period are charged on snapshot day like anyone else — the 0%
  first band protects small starting balances.

**UX**
- Statement lines show the charge with band breakdown on demand.
- Show a projected next charge on the member's dashboard ("if unspent, ~X on the
  1st") — reinforces the spend-it psychology, which is the point.

## 2. Multi-tenancy — DECIDED 2026-07-08

Multi-tenancy is designed into the data model from the start. Target deployment
models: (a) self-hosted single group, (b) **white-label SaaS** hosting many groups —
most LETS lack the technical capacity to run their own server, and nobody in the UK
space offers hosted LETS software (CES is the closest model).

**Data model**
- `group` (tenant) is a first-class entity; **every domain entity carries a
  `group_id`** and all unique constraints are tenant-scoped (member numbers,
  category names, currency symbols are unique *per group*, not globally).
- **Auth identity is global, membership is per-group**: a `user` (credentials,
  email, passkeys) is separate from a `member` (a user's membership + accounts in
  one group). One person can belong to several LETS with one login — common in
  practice (CES supports this) and it makes future intertrading natural.
- Currencies belong to a group (a group may have several, per plan.md).
- A self-hosted deployment is simply an instance with one group row — no separate
  code path.

**White-label (per-group config)**
- Branding: display name, logo, colour theme; custom domain / subdomain — tenant
  resolution by hostname.
- Per-group: currencies + demurrage bands, categories, CMS pages/news, email sender
  identity ("from" name), membership agreement text, feature toggles (e.g.
  transparency options from decision #3).
- Per-group plan/status field reserved for SaaS billing — billing itself out of
  scope for now.

**Isolation**
- Tenancy enforced at the storage/repository layer: every query is group-scoped by
  construction, not by caller discipline. API tokens and sessions are scoped to a
  group membership (a multi-group user selects a group context).
- Physical storage is behind the pluggable interface: first implementation is one
  SQLite database with `group_id` columns; the interface leaves open either shared
  Postgres schema (optionally with row-level security) or database-per-tenant as
  SaaS scale-up paths. Because the schema is tenant-keyed either way, this choice
  is deferred without risk.

**Roles**
- Platform level: **operator/super-admin** (cross-group: provisioning, support,
  never appears in group directories).
- Group level: admin/committee/member roles as per the references (refined in #3
  and #7).

**Bonus**: co-hosted groups on one SaaS instance make future inter-LETS trading
(decision #4) an internal transfer between gateway accounts rather than a federation
protocol problem.
## 3. Credit-control levers — DECIDED 2026-07-08

Credit control is a **pluggable policy layer**, not hard-wired rules. A group
activates zero or more policies per currency; the initial release ships three.

**Policy interface**
- Two hook points:
  1. **Transaction authorisation** (synchronous): `(payer account, payee account,
     amount, policy config) → allow | deny(reason)`. Any active policy denying
     blocks the transaction with a clear member-facing message.
  2. **Periodic evaluation** (scheduled + on balance change): emits **flags** on
     accounts — level + reason — consumed by dashboards, reports, directory
     badges, and notifications. Flags never block by themselves.
- Config is per-currency with **per-member overrides** (trusted members get wider
  limits — standard across references).
- Policies apply to both signs: debit thresholds (classic LETS) and credit
  thresholds (Sardex-style anti-hoarding, complements demurrage).

**Initial policies**
1. **Soft flagging at thresholds** — ordered list of thresholds per sign, each with
   an escalation level (e.g. CamLETS: ±200 → "notice" flag, ±400 → "committee
   review" flag). Crossing a threshold optionally notifies the member and/or
   committee. Flags visible per group transparency settings.
2. **Optional hard limit** — per-currency max debit and/or max credit balance;
   transactions that would breach it are denied. Per-member override. Off by
   default (pure social-pressure groups run soft-only).
3. **Manual restriction** — admin flag on a member blocking **outward payments**
   (they can still earn their way back up); imposed/lifted by admin with
   notification emails both ways and an audit-log entry. (The legacy "leecher
   management" feature.)

**Future policies the interface must not preclude** (not building now):
turnover-proportional limits (Sardex: limit ≈ f(member's trailing turnover)),
time-limited debt (must return toward zero within N months), first-year tighter
limits (CamLETS rule), feedback-informed limits.

**Notes**
- Demurrage (#1) is *not* a credit-control policy — it's a fee engine — but both
  read the same per-currency config surface and their thresholds should be
  presentable together in admin UI ("your currency's rules" in one place).
- Deny reasons must be specific ("this payment would take you below −400, the
  group's limit") — opaque failures poison trust in a community system.
## 4. Federation — DECIDED 2026-07-08

**Not implemented yet.** Design so it isn't precluded; target the gateway-account
model (CES / Credit Commons) when the time comes.

What we reserve now so nothing blocks it later:

- **Account types include `gateway`** (already in #1's exemption list and #7's
  account types). A gateway account holds a group's net position against one
  external counterparty (another group, or a Credit Commons node). Exempt from
  demurrage and credit-control policies by default; balance visible to admins.
- **Transaction model allows non-member counterparties**: a trade's leg can point
  at a gateway account, with a `remote_ref` field (opaque external transaction
  id/description) so a member's statement can show "→ Falmouth LETS: veg box
  (via gateway)".
- **Multi-phase transaction states** (decided properly in #5) must include a
  pending/committed distinction — Credit Commons requires create → validate →
  commit across nodes, so a two-phase local model composes with it.
- **Currency exchange rates**: currencies already carry properties; leave room for
  a rate relative to a reference unit (Credit Commons expresses amounts in the
  trunkward node's unit). No rate logic now.
- **Same-instance intertrading first**: two groups hosted on one SaaS instance
  (#2) can intertrade via paired gateway accounts as an ordinary internal
  double-entry — no protocol needed. This is the natural first federation
  milestone and exercises the same account plumbing.
- Policy knob to record when implemented: cap gateway exposure (Tauschring rule of
  thumb: ≤ ~10% of scheme activity).

Explicitly out of scope now: Credit Commons protocol endpoints, mirrored-account
hash chains, cross-instance anything.
## 5. Pending-payment & invoicing model — DECIDED 2026-07-08

Two-phase transactions, mimicking card authorisation/settlement. Core principle:
**both parties must consent to a trade, but initiating is consenting** — and
nobody's balance ever decreases without their explicit act (the payer always
authorises, whether by initiating a payment or accepting an invoice).

**Why payee consent matters here** (not just payer): under demurrage an unwanted
incoming payment costs the recipient money on posting day — and is the vehicle for
the collusive-parking dodge accepted in #1, which mustn't be executable against a
non-consenting account. Pushed payments can also breach credit-side thresholds
(#3) and pollute a member's visible trading record/turnover. Hence the opt-in
below (as in legacy Local Exchange).

**Transaction types**
- **Payment** (payer-initiated push): commits immediately by default. If the payee
  has enabled per-member **"confirm incoming payments"**, it enters `pending` until
  the payee accepts or declines. Unactioned pending payments **auto-accept after N
  days** (group-configurable, default 14) with notification — refusal is the
  exception; money should flow.
- **Invoice** (payee-initiated request): always `pending` until the **payer**
  accepts (→ committed) or declines. Initiator may cancel while pending. Invoices
  expire after N days (group-configurable).
- **QR/EPOS flow = an invoice**: payee's QR (payee id, amount, suggested reference)
  is the request; payer's scan-and-authorise is the acceptance, committing
  instantly. One model covers online and in-person.

**State machine**
`pending → committed | declined | cancelled | expired`
- Only `committed` transactions touch the ledger; pending transactions place **no
  hold** on funds (unlike card auth — LETS limits are mostly soft; simplicity
  wins). Consequence: credit-control authorisation (#3) runs at **commit time**,
  so accepting an old invoice can still be denied by a hard limit, with the
  specific reason shown.
- `committed` entries are immutable. Reversal (admin, or future dispute flow) is a
  **compensating transaction** linked via `reverses_id` — never mutation or
  deletion (feeds #6).
- Action-required counts surface in the UI (pending invoices to pay, payments to
  confirm) — the legacy systems' pattern.
- Two-phase pending→committed is exactly the shape Credit Commons federation needs
  (#4: create → validate → commit), so gateway transactions reuse this machine.

**Notifications**: invoice received, payment received/held, accepted/declined,
expiry warning. All respect member notification preferences.
## 6. Ledger representation — DECIDED 2026-07-08

**Normalised append-only journal; double-entry; zero-sum by construction; balances
are cached/derived quantities owned by the storage layer.**

**Schema shape**
- `transaction` (header): group, type (`trade | demurrage | fee | reversal | …`),
  state (#5), reference/description, created_by, timestamps, `reverses_id`
  (compensating link), `remote_ref` (gateway, #4), idempotency key.
- `entry` (legs): transaction_id, account_id, signed amount. A leg's currency is
  **implicit via its account** (accounts are per-currency), so multi-currency
  transactions need no extra columns. **Invariant: within a transaction, the legs
  of each currency sum to zero** — enforced in the write path (and by DB
  constraint/trigger where the backend allows). Double-entry is thus zero-sum by
  construction, per currency; the "audit: balances sum to zero" management
  function becomes a consistency *verification*, not an accounting hope.
- Normally two legs, but **multi-leg and multi-currency are supported**
  (Cardano-style multi-asset value model). Enables: income-tie splits (payment +
  % to community fund atomically), batch fee runs, **atomic swaps** between
  currencies with no exchange-rate machinery (the leg amounts *are* the agreed
  ratio), **vouchers** modelled as limited-issue currencies bought/redeemed
  atomically, and mixed-currency fees (e.g. "20 cams + £8" renewal as one
  transaction, if the group tracks a sterling bookkeeping currency). Demurrage
  posts as one transaction per member per run (statement clarity), referencing
  the run id.
- Transactions remain **group-scoped** (every account in one transaction belongs
  to the same group) — tenancy isolation (#2) holds. Cross-group trades stay
  paired gateway transactions (#4); within a group, cross-currency needs no rate
  logic at all.
- `account` is its own entity: (group, currency, type: `member | community |
  system | gateway`, owner). A member has one account per currency they use.
- Amounts are **signed integers in minor units**; the currency defines its scale.
  No floats anywhere in the money path.

**Append-only discipline**
- Committed transactions and their entries are never updated or deleted.
  Corrections are compensating transactions (`reverses_id`). Pending-state
  transitions (#5) touch only the header state field; **balance queries consider
  committed entries only**.

**Balances: a storage-layer concern**
- The storage interface exposes balance queries — `balance(account)`,
  `balancesFor(group, currency)`, statements with running balance — and an
  **atomic `postTransaction`** (invariant check + commit-time policy hooks (#3)
  + balance effects, all-or-nothing).
- Whether balances are derived on read, incrementally cached, or materialised is
  the **storage implementation's private decision**. Contract: a balance query
  must equal the sum of committed entries at all times, atomically with respect
  to posts.
- A scheduled **verification job** recomputes balances from the journal and
  compares with reported balances; any mismatch is a storage bug — alert loudly
  (the legacy system's FATAL/SILENT out-of-balance config is the cautionary
  tale; here there is no "silent" option).
- Statements need stable ordering: monotonic sequence per group alongside
  timestamps.

**Idempotency**: `postTransaction` accepts a caller idempotency key (QR
double-scan, demurrage run re-execution, future federation retries) — replays
return the original result.
## 7. Membership lifecycle & fees — DECIDED 2026-07-08

**No membership fees.** Demurrage (#1) funds the community account, which pays for
admin work and community projects in local currency. This removes the entire
renewal/fee machinery the reference systems carry (annual renewals, dual-currency
fee bookkeeping, fee runs, exemption lists).

**Fiat costs**: hosting is the only sterling cost, and minimising it is a design
constraint — a multi-group, multi-currency instance serving thousands of members
should run on a minimal VPS/EC2 (SQLite-friendly schema, lightweight Node server,
no heavyweight infra dependencies).

**Lifecycle**
```
applied → active ⇄ away(holiday) → leaving/removed → closed
              ⇅
          suspended
```
- **Apply**: online form (contact details, intro), agreement + GDPR consent
  checkboxes, email verification. Admin approves (→ active, welcome email) or
  rejects (notified; data purged after a retention window).
- **Active**: full trading, listings, directory presence.
- **Away/holiday**: member self-service; listings hidden, digests paused;
  trading still possible. (Reference-standard feature.)
- **Suspended**: admin action (disputes, abuse); blocks trading and hides
  listings/directory entry; demurrage still applies while the account is open
  (#1). Reversible; notifications + audit log both ways.
- **Leave/remove**: voluntary exit or admin removal share one settlement flow:
  member is encouraged to trade back toward zero first (CamLETS rule), then any
  **residual balance — either sign — settles to the community account** as an
  ordinary typed transaction (`settlement`), accounts close, listings end.
  Positive residue enriches the community; negative residue is absorbed
  transparently (visible in the community account's history — social pressure's
  backstop).
- **Data on exit**: journal is append-only (#6), so entries are never deleted —
  instead the member/user records are anonymised after a retention window;
  accounts persist as anonymous ledger counterparties. Satisfies GDPR erasure
  without breaking audit-to-zero.

**Dormancy** (the cost of having no renewal cycle): nothing expires membership
automatically, so dead accounts accumulate. Mitigations: listing auto-expiry for
inactive members (reference-standard), dormancy flags from #3's periodic
evaluation feeding an admin review queue, and demurrage naturally draining
dormant positive balances to the community account. Dormant negative balances
only clear via the removal flow.

**Account structure**: membership types individual / joint-household /
organisation; multiple **persons** per membership (own name + contact + email
login, shared accounts) — the reference-standard joint-member pattern, mapped to
#2's user-vs-member split (several users linked to one member).
## 8. Reputation — DECIDED 2026-07-08

**No per-trade ratings.** Evidence review (2026-07-08): several platforms shipped
eBay-style feedback (legacy Local Exchange with rebuttals; Cyclos references +
qualifications; hOurworld satisfaction ratings) but there is **no documented case
of it working** in a community-currency context in 20+ years; MCM appears to have
dropped the legacy feature (correcting first-review.md, which over-claimed it);
Slater specced ratings twice for Community Forge and never shipped them. The
marketplace literature (Nosko & Tadelis; Klein et al.; Fradkin et al.; Filippas
et al.; Couchsurfing studies) shows public bilateral feedback degrades into
uniform positivity via retaliation fear and non-response bias — mechanisms driven
by the social cost of public negatives, which is maximal in a face-to-face
community — and rating sparsity (a few trades/year) makes scores meaningless
anyway. Trust ranks ~fourth among documented limits on LETS trading, behind
debt-aversion, skills mismatch, and organiser burnout. The systems that solved
trust at scale (Sardex, WIR, CES, UK timebanks) all used the same non-rating
stack: gatekeeping at entry, scaled credit limits, transparent balances/history,
human mediation.

**What we build instead** (mostly already decided elsewhere):
- Transparency of balances, turnover, and history (#3) — Linton's original
  design fundamental.
- **Trade-count statistics on member profiles**: "N trades with M distinct
  members since <date>", recency of last trade. Activity + breadth of
  counterparties is the signal that outperforms scores (effective-percent-style
  metrics); computed from the journal, costs nothing.
- **Qualified / professional flags** on listings (reference-standard: Falmouth's
  "(Pr)"/"(S)") — admin-verified badges, not peer scores.
- Approval at entry (#7); manual restriction (#3); dispute mediation stays a
  governance process (committee/mediator), supported by the audit trail, not by
  software scoring.

**Door left open**: an optional private-feedback plugin (Simbi-style: private,
multi-axis, aggregated, minimum-N threshold before display) could slot into #3's
policy/flag machinery later if a group demands it. Not building it now. Public
per-trade negatives with rebuttals is explicitly rejected.

## 9. MCP server auth — DECIDED 2026-07-08

The MCP server is a thin client of the same REST API as the web UI (API-first,
#first-review). Auth follows from #2's identity model and #5's state machine.

**Tokens**
- Per **membership** (user × group), not per user: an MCP token acts as one
  member in one group. Created and revoked from the member's profile page
  (and/or MCP OAuth flow later — the MCP spec supports OAuth 2.1; start with
  personal access tokens, which shared-hosting-grade deployments can manage).
- Attributes: scopes, optional expiry, per-token label, last-used timestamp.
  All MCP actions are audit-logged with the token id. Rate-limited per token.

**Scopes** (least privilege, member-grantable)
- `marketplace:read` — offers/wants search; respects the group's public/member
  visibility tiers.
- `directory:read` — member directory at member visibility level.
- `account:read` — own balances, statements, pending items.
- `listings:write` — create/update own offers & wants.
- `trade:request` — create invoices, and create payments **that enter `pending`
  and require the member's confirmation in the web UI** (reuses #5's machinery —
  an agent can set up a payment but a human act commits it).
- `trade:autonomous` — payments commit without confirmation, bounded by
  **per-token limits: max amount per transaction and per rolling period**, set
  at grant time. Deliberate extra step to enable; the default agent experience
  is request-then-confirm.
- No admin scopes over MCP in v1.

**Design point**: the payment-confirmation flow needed no new mechanism — #5's
pending → committed distinction is exactly the human-in-the-loop boundary for
AI agents. Credit-control (#3) applies at commit regardless of channel.

## 10. Tamper-evidence — DECIDED 2026-07-08

Make ledger history tamper-evident so that neither a compromised server, a rogue
self-host admin, nor the SaaS **operator themselves** can silently rewrite it —
"you don't have to trust the host" is a differentiator for white-label hosting
(#2), and chained hashes are also what Credit Commons federation expects (#4).
Cheap because the journal is append-only (#6): tamper-evidence over append-only
data is one hash column; it's rewriteable ledgers that make it hard.

**Journal hash chain** (continuous)
- At commit, inside the same atomic storage transaction that assigns the
  per-group `seq`: `hash = H(prev_hash ‖ canonical(header + entries))`.
- Chain order is commit order — per-group commits are already serialised
  (single-writer SQLite; trivial volume), so there is no race. The chain links
  by `prev_hash`, never by arithmetic on `seq`, so sequence gaps can never break
  verification.
- Only committed transactions are chained; pending-phase concurrency (#5) is
  outside the chain. Reversals are new chained transactions (#6).
- **Canonical serialisation is the engineering risk**: hash over a byte-stable,
  versioned encoding (fixed field order; all-integer money, no float
  ambiguity). Specify once, version it (`hash_version`).

**Merkle checkpoints** (periodic — monthly, natural cadence alongside the
demurrage run)
- Merkle tree over every account's `(account_id, balance, last_entry_seq)` plus
  the journal head hash; checkpoint roots chain to each other.
- Gives each member an **inclusion proof of their own balance** without
  revealing anyone else's data — the benefit of per-account chains without
  maintaining N live chains atomically on every multi-leg transaction
  (demurrage runs and swaps touch many accounts at once).

**Witnesses** — pluggable root publishers (terminology from a prior project):
- Newsletter/market-day flyer (print the root — very stamp scrip)
- Digest email (every member's inbox is an independent witness)
- Public git repo
- **Cross-group witnessing** — free on a multi-tenant instance: groups witness
  each other's roots
- Blockchain anchor as one more plugin for whoever wants it
Witness receipts recorded per checkpoint.

**Verification**: the storage `verify` operation extends to recompute the chain
and checkpoint roots; member-facing "verify my statement" shows the inclusion
proof; full journal export allows independent offline audit.

**Future option, not built**: passkey-signed payment authorisations would
upgrade tamper-evidence to non-repudiation of member consent — the door is open
because payer-authorises is already the invariant (#5) and passkeys are already
required (plan).

## 11. UI architecture — DECIDED 2026-07-08

Two UIs, one API, same origin.

**Packages**: `ui/member` (consumer, mobile-first), `ui/admin` (desktop,
admin/operator), `ui/shared` (typed API client + money formatting; MUI-free so
both apps can consume it). All React + TypeScript + Vite + MUI.

**Same-origin serving**: the Fastify server serves both built apps via static
files with SPA fallback — member app at `/`, admin at `/admin/`, API at
`/api/v1`. No CORS anywhere; cookie sessions just work; tenancy-by-hostname
applies to the UI exactly as to the API (visit the group's domain, get its
branded app). One process on the minimal VPS (#2, #7). Dev mode: Vite proxy to
:1862.

**Member app — mobile-first PWA**:
- `vite-plugin-pwa`: installable, camera access for the QR payment flow
  (decision #5: the QR is an invoice — payee shows {payee, amount, reference},
  payer scans and authorises). Capacitor kept as the later native-wrap path
  (plan.md's Android/iOS option) — a Vite PWA wraps nearly unchanged.
- Bottom-tab IA: Home (balance, activity, later projected demurrage #1) ·
  Market (offers/wants, public browse when logged out) · Pay (centre action:
  scan / show QR / manual) · Activity (statement + pending accept/decline with
  action badge) · More (profile, settings, directory).
- Current MUI (no Rafiki dependency).

**Admin app — desktop, Rafiki** (`@sandtreader/rafiki`, npm):
- Used for the `Framework` shell, login flow, and `MenuStructure` navigation
  (capability globs mapped from member role / operator flag). Pages are custom
  MUI components — `ListEditPage`/`BasicForm` only where a flow is genuinely
  CRUD-shaped; admin flows are mostly action-shaped (approve/suspend/restrict).
- Custom `AuthenticationProvider` over the cookie-session API (`/auth/login` +
  `/me` → capabilities). Rafiki pins MUI 5 / React 18 — admin app matches.
- Known gaps accepted for now: no session restore on reload (candidate small
  upstream Rafiki improvement: initial-session/restoreSession hook); our API
  layer catches all errors and surfaces them (snackbar) rather than throwing
  into Rafiki components.
- **Upstream Rafiki changes are approved so long as they stay backwards
  compatible** (additive props/hooks only). MUI-major posture: admin app starts
  on MUI 5 matching Rafiki today (zero blast radius); widening Rafiki's peer
  range to `^5 || ^6 || ^7` with a CI build matrix is the preferred future
  route — never a hard bump that forces existing Rafiki apps to migrate in
  lockstep.

**API client**: generated from the server's own OpenAPI document
(`openapi-typescript`) so types cannot drift from the server; falls back to
hand-written interfaces only if the route schemas prove too thin to generate
useful response types.

*(Amended by #12: the public market browse moves out of the member app to the
brochure site; the app becomes logged-in-only and is served inside the
brochure shell.)*

## 12. Public brochure site & app shell — DECIDED 2026-07-09

Each group's site root is a **public brochure site** — the group's face to the
world — and the member app renders **inside it** when logged in. One origin,
one PWA, one visual shell.

**Why a brochure site**: every LETS site is half community noticeboard
(first-review), and it's how groups recruit. That content — what the group is,
how to join, agreement/constitution, news, and the public marketplace browse —
wants to be **server-rendered HTML**: indexable, link-previewable, readable on
anything, near-zero JS. A client-rendered SPA behind a service worker is the
wrong vehicle for a public face regardless of screen size.

**Shape**
- **Brochure at `/`**: Fastify renders CMS content (`page`, `news_item`,
  data-model §6) plus a read-only public marketplace browse through a simple
  per-group layout template. Oriented to PC, responsive down to mobile.
- **App is logged-in-only** (amends #11): the public market browse leaves the
  member app; Market becomes an authenticated tab like the rest.
- **The app renders in the brochure, not linked from it**: the same
  server-rendered layout (header with group skin, nav) wraps both brochure
  page bodies and the React app's mount point; app routes serve the shell plus
  the bundle, and client-side routing keeps the chrome. Same origin means the
  cookie session is shared: the brochure header knows who you are, and
  members-visibility pages render when logged in.
- **One PWA, direct mobile access**: single manifest, service worker scoped
  to the app paths (which by itself keeps brochure HTML out of its reach);
  `start_url` is the app home with `display: standalone`, so
  installing gives home-screen-linkable access straight into the app. The
  brochure wrapper is **progressive chrome**, not an iframe: full nav on a
  desktop browser, a slim logo/name banner on a mobile browser, and hidden
  entirely in the installed app (`@media (display-mode: standalone)`). Deep
  links to app routes work everywhere — every app URL serves shell + bundle.

**Per-group skinning — deliberately lightweight** ("no more than a Facebook
page"): display name, logo, header background image. Stored behind opaque
blob refs on `group.branding` (same storage-layer posture as member/listing
photos: SQLite blobs first, enforced size limits), uploaded via admin routes,
served to the shell as template variables + a public asset route. No custom
CSS, no theme builder — white-label beyond this stays a later concern (#2's
branded-domain story already covers the important part: your domain, your
name, your logo).

**Consequences**
- Member-app IA in #11 loses "public browse when logged out"; login/apply
  remain app routes served within the shell.
- The service worker must not cache brochure HTML as an app shell for
  logged-out visitors (fresh public content wins); precache only the app
  bundle.
- Admin app is untouched at `/admin/`.

*(Amended by #15: the app's shell chrome is client-rendered by the React
app from a public `/shell` endpoint, not injected server-side; #15 also
fixes how the skinning images are stored.)*

## 13. CMS content format — DECIDED 2026-07-09

**Markdown in, HTML out, server-side, via markdown-it.** CMS bodies (`page`,
`news_item`, data-model §6) are authored and stored as markdown source only —
never HTML. We can't assume volunteer admins write valid HTML, and accepting
HTML means sanitising it forever; markdown's genius is that plain paragraphs
are already valid input.

**Rendering**
- `markdown-it` with defaults: `html: false` escapes any raw HTML in the
  source (output can only contain markup generated from markdown constructs
  — no sanitiser pass), and link destinations are validated (`javascript:`
  blocked). One small dependency, safe unconfigured — fits the minimal-VPS
  posture (#7).
- Rendered at request time in the brochure (#12); source is canonical, edits
  round-trip losslessly, renderer upgrades need no data migration. Caching
  only if it ever measures slow (it won't at page sizes).
- **Images disabled for now**: markdown image syntax is off until a general
  group image store exists (blob storage, same posture as photos/branding
  #12) to serve as the image source. External image URLs stay blocked even
  then — broken/tracking third-party images on a public brochure are worse
  than none.
- **Deliberately small formatting surface** — no extensions, no embeds, no
  footnotes. These are info pages and notices, not a blogging platform.

**Editing**: admin UI textarea with live preview, running markdown-it in the
browser with the same options as the server. If volunteers struggle, the
upgrade path is a markdown-*emitting* editor — the stored format never
changes to HTML.

**Scope**: pages and news now; group-editable email templates later reuse the
same pathway (renders to HTML for a future multipart email, degrades to
readable plain text for today's). Listing descriptions stay plain text —
listings should stay simple.

## 14. Image storage — DECIDED 2026-07-09

**One general `images` table, three owners; blobs in SQLite behind opaque
ids** (the storage-layer posture data-model §5 reserved). Domain rows point
at images by id; CMS markdown references them by URL. One serving route, one
upload pipeline, one place limits live.

**Schema**: `images: id (uuid), group_id, owner_kind (cms | member |
listing), owner_id?, mime, size, width?, height?, blob, created_by,
created_at`. Per-owner rules: `cms` — admin-uploaded, referenced from
markdown; `member` — exactly one profile photo, upload replaces; `listing` —
up to 5, ordered by upload.

**Serving**: `GET /i/{id}` — correct Content-Type, `X-Content-Type-Options:
nosniff`, and `Cache-Control: public, max-age=31536000, immutable` (an id's
content never changes; re-upload mints a new id — repeat views are browser
cache hits, kind to the minimal VPS). Access control is by unguessable UUID,
no session check: CMS and listing images are public-brochure content anyway,
and a leaked member-photo URL is low-stakes. The pragmatic norm.

**Client-side resizing, not server-side.** Server-side processing means a
heavy native dependency (sharp) — wrong for the minimal-VPS posture (#7).
The uploading UI downscales via canvas before upload (CMS max 1600px,
listings 1200px, profile 512px, re-encoded JPEG/WebP — which also strips
EXIF, a real privacy win: no GPS coordinates in profile photos). The server
only **validates**: magic-byte sniff against a jpeg/png/webp whitelist, hard
byte caps (2MB cms / 1MB listing / 256KB member), per-owner count limits,
and a per-group total quota (default 500MB; a constant for now, per-group
plan setting later, #2). A determined API user can upload an
unoptimised-but-under-cap image; the caps bound the damage.

**Markdown images re-enabled with an allowlist** (amends #13's interim
block): only `/i/{uuid}` sources render as `<img>`; anything else — external
URLs included — degrades to text exactly as before. Small, testable rule;
the external-image block stays permanent.

**Upload transport**: raw request body (`fetch(url, {method: 'POST', body:
file})` with the file's content type), not multipart — no @fastify/multipart
dependency, fine for single-file uploads.

**Phasing**: (1) images storage + `/i/` serving + CMS admin screen (with
copy-the-markdown-snippet affordance) + the markdown allowlist; (2) member
profile photo; (3) listing photos.

## 15. Group skinning storage & app-shell chrome — DECIDED 2026-07-09

The two #12 follow-ups, resolved together.

**Skinning storage**: the logo and header background image are a fourth
owner kind in the #14 image store — `brand`, `owner_id` naming the slot
(`logo` | `header`), 1MB cap, exactly one image per slot with
replace-on-upload (the member-photo pattern). No new tables, no columns on
`groups`: branding is derived from the images table exactly as `photoId`
is. Admin routes `PUT/DELETE /admin/branding/{slot}` take the raw image
body; serving stays `GET /i/{id}` with the same immutable caching.

**App-shell chrome is client-rendered** (amends #12's server-side
injection; see ui/shell-chrome.md for the evidence). Two mechanisms defeat
injection in practice: the service worker answers every post-first-visit
`/app/*` navigation from its precached raw index.html, and within one
served page the static header ignores SPA login state. So the React app
renders the same slim chrome itself — brand and nav from a new public,
session-aware `GET /shell` endpoint (group name, branding image ids, the
viewer's visible nav pages, the member's name), session corner from the
auth state it already holds. Present on every load including offline,
always truthful about the session, hidden in the installed PWA by the same
`display-mode: standalone` media query. The cost accepted: the chrome
exists twice (server template for brochure pages, React component for the
app) and must stay visually in step. Server-side injection into the app's
index.html is dropped entirely.

## 16. Group-editable email templates — DECIDED 2026-07-09

**Every notification kind has a built-in default template; groups override
per kind** (the "per-group email sender" line in #12, mechanised via #13's
markdown pathway).

- **Templates are markdown with `{{placeholder}}` substitution** (e.g.
  `{{memberName}}`, `{{groupName}}`, `{{amount}}`, `{{payerName}}`,
  `{{reason}}`). Substitution is plain string replacement before markdown
  rendering — markdown-it's escaping then applies to the substituted
  values, so member-supplied names can't inject markup. An unknown
  placeholder passes through literally: visible in the admin preview, honest
  in a sent mail, never a crash.
- **Storage**: `email_templates (group_id, kind, subject, body)`, unique
  per (group, kind). A row is an override; deleting it reverts to the
  built-in default. Defaults live in code, not seeded rows — new
  notification kinds appear for every group without data migration.
- **Delivery is multipart**: the substituted markdown source is the
  `text/plain` part (markdown degrades to readable plain text, #13's bet)
  and its rendered HTML the `text/html` part. Rendering happens at
  delivery, so `email_events.body` keeps storing the readable source.
- **Per-group sender**: `groups.email_from`, editable by group admins,
  snapshotted onto each queued event (`email_events.from_email`) at
  enqueue time; delivery falls back to the instance-wide
  `SILVIO_EMAIL_FROM` when unset. Deliverability (SPF/DKIM for the chosen
  domain) is the operator's problem to configure, documented, not policed.
- **Editing UI** reuses the #13 pattern: subject field + markdown body with
  live preview, plus a substitutable-placeholder reference per kind.

## 17. Offers & wants digest and admin broadcast — DECIDED 2026-07-10

The last two Email & notifications items, mechanised on the #16 pathway.

**Digest**: each member chooses `digestFrequency` — `none | weekly |
monthly`, default **weekly** (the digest is the modern form of the LETS
offers-and-wants sheet; joining the group is joining that conversation, and
opting out is one tap). Content is **what's new**: listings created within
the period window (7/31 days), grouped offers-then-wants; an empty digest
is not sent. Generation is a scheduler-tick sweep, idempotent via the
existing email dedup keys scoped to a period label (the week's Monday date
or the month) — however often the tick runs, one digest per member per
period. Wording is group-editable as the `digest` template kind
({{listings}} carries the pre-rendered markdown section).

**Broadcast**: `POST /admin/broadcast {subject, body}` — markdown body,
one email per person (with an email address) on every active membership,
queued through the standard outbox (multipart, per-group sender). No
template and no storage of its own: a broadcast is ad-hoc by nature, and
the email_events log already records what was sent to whom. No
targeting/segments until a group asks.

## 18. Listing shelf life — DECIDED 2026-07-10

Listings expire by default so the market stays honest (the
reference-standard "inactive member" cure, keyed to the listing rather
than heuristics about its owner).

- **Default shelf life**: new listings get `expiresAt = now +
  listingMaxAgeDays` (group setting, default 180 days); an explicitly
  supplied expiry wins. Pre-existing rows without an expiry are left
  eternal — the default applies at posting time.
- **Warning email 14 days out** (template kind `listing_expiry_warning`,
  #16 pathway): sent once per (listing, expiry date) via the standard
  dedup, from the same scheduler sweep that expires listings.
- **Renew is one tap by the owner**: `POST /listings/{id}/renew` resets
  the clock to a full shelf life, and within the purge window it also
  revives an already-expired listing (status back to active).
- **Purge 90 days after expiry** (constant): the sweep hard-deletes the
  listing row and its photos — expired listings are clutter, not ledger
  history; nothing references them.

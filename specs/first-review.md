# Silvio — First Review: Reference Research & Gap Analysis

Research review of the references in [plan.md](plan.md) plus a wider survey of the
mutual-credit / community-currency software space, followed by proposed features and
architectural decisions missing from the initial plan. Decisions to be refined
sequentially; see [Open decisions](#open-decisions) at the end.

Date: 2026-07-08

---

## Part 1: What the references do

### CamLETS (cam.letslink.org)

Cambridge LETS, est. 1993, currency "cams" (standard rate 10 cams/hour, negotiable).
Runs on the LETSlink-hosted legacy PHP platform.

- Everyone starts at zero; zero-sum system; no interest; spend before earning allowed.
- **Account #1 = community/system account**; leavers' residual balances (either sign)
  transfer to it. Automatic fee debits are the only non-holder-initiated transfers.
- **Membership**: public application form → acknowledgement checkboxes (fees, data
  sharing, self-maintenance of listings, constitution) → secretary-driven manual
  renewal. Fees dual-currency: e.g. renewal 20 cams + £8, or 30 cams only, or
  sterling-only if balance below −50. Joint memberships via extra email addresses.
- **Credit control is soft and staged**: ±200 cams = flag/extra prominence; ±400 =
  Chair review + trading support; Core Group can intervene. First-year members below
  −100 must earn before resuming spending. Full transparency: all balances, history,
  turnover, feedback visible to members, who are encouraged to check before trading.
- **Trading**: online payment *or invoice* entry; paper "Personal Trading Sheets" at
  events entered later in batch; paper credit notes valid 12 months.
- **Directory**: offers/wants with category, rate, expiry, on/off toggle (holidays),
  photos; Directory Editor role recategorises. Location grid + neighbourhood
  filtering. Public sees listings without contact details.
- **Privacy tiers per field**: partial postcode public, full postcode members-only,
  street address private. GDPR consent at signup.
- **Buddy scheme**: proxy management — buddies maintain profiles/listings/transactions
  for offline members.
- Weekly/monthly/never email bulletins of new & changed offers/wants; monthly trading
  events; agendas/minutes published; dispute process (informal → working party);
  cams treasury with budgets for admin work paid in cams; community balance target ±500.

### Falmouth LETS (falmouthlets.uk)

Runs **Mutual Credit Manager** (see below). Currency "Palm".

- All accounts start at zero; spend before earning; no fixed limits but Admin Group
  discretion to impose them. Only account holder can authorise transfers out.
- Joining/renewal fees in Palms and/or sterling; admin may levy service charges;
  admin may publish balances and turnovers (transparency rule). Leavers must balance
  their account first.
- Offers & Wants publicly browsable, contact details behind login; 24 categories;
  freshness filter; flags for professional "(Pr)" and qualified "(S)" services.
- Members: photo profiles, joint members (household accounts), email digests of new
  offers/wants, payments *and* invoices, transaction history.
- Treasurer records transactions on behalf of offline members (proxy).
- Gaps observed: manual paper/email joining, no online stats/reports, no events RSVP,
  no member-to-member messaging.

### Mutual Credit Manager (mutualcreditmanager.co.uk, github.com/cdmweb/mutualcreditmanager)

Successor to Local Exchange; PHP/Slim 3/MySQL, GPL v3, self-host on shared hosting.
Purpose-built with Falmouth LETS.

- Group setup: currency name, custom categories, CMS pages (WYSIWYG), custom nav
  menu, news, theming/logo/CSS.
- Members: self-serve signup with email verification, token password reset, joint
  members, holiday mode, photo profiles, public searchable member list, banned users.
  Role tiers: Open / MinAccount / MinMember / MinEditor / Admin / SuperAdmin;
  super-admin can **"login as" any account** (proxy).
- Trading: send payment, request payment (invoice), cancel invoice, admin reversal,
  automatic balance adjustment, **integrity check that balances sum to zero**, public
  recent-exchanges feed. (Correction 2026-07-08: per-trade feedback is *not* in MCM's
  advertised feature list — it appears to have been dropped from the legacy system;
  see decisions.md #8.)
- Admin/treasury: dashboard, one-off service charges (take + refund), bulk email,
  event/audit log, contact form with rate limiting.
- Scheduled jobs: cron endpoint (or pseudo-cron on page loads) for email digests,
  offer expiry, offer reactivation.
- Notable gaps: single-group only, email-only notifications, no in-app messaging, no
  reports/statistics, no events calendar, tiny API (one GetMembers endpoint), no i18n.

### Local Exchange UK (github.com/cdmweb/Local-Exchange-UK)

Legacy PHP4/MySQL (2009–2013), the system MCM replaced. Fullest feature inventory of
the four; also the best catalogue of design mistakes.

Features worth carrying forward:

- Account types: Single, Joint, Household, Organization, Business, Fund; multiple
  persons per account with a primary-member flag.
- **Payment confirmation**: per-member opt-in; incoming payments held pending until
  recipient accepts/rejects. Member-to-member **invoicing** (site-togglable) with
  pending queue and action counts in the menu.
- **Feedback/reputation**: eBay-style positive/neutral/negative per trade + comment,
  **rebuttals** by the subject, percent-positive score, 30-day feedback window.
- **Restrictions ("leecher" management)**: admin blocks outward spending for members
  who take without giving; notification emails both ways.
- **Income ties**: member donates a configurable % of any income to a chosen account
  (e.g. community fund), processed on every trade.
- Fees: monthly membership fee runs (take + refund, exemption list) and one-off
  service charges, paid to a system account.
- Integrity: sum-to-zero verification during trades; configurable FATAL/SILENT
  out-of-balance behaviour + admin email alert; balance total shown atop admin panel.
- Listings: auto-expiry for inactive members (no trade/update in 180 days → warning
  email → expire → purge); hierarchical categories; partial-postcode display.
- Holiday mode, login lockout after N failures, admin audit log, DB-stored typed
  settings editable in admin UI, info-page CMS with per-page permission levels,
  member-to-member email that hides addresses, opt-in listing digests
  (daily/weekly/monthly), PDF member directory, spreadsheet export, MySQL backup,
  "never logged in" report, maintenance mode.
- No multi-currency, no inter-LETS, no API.

Design smells to avoid in a rewrite: login-string-as-PK, **denormalized balance
column kept honest only by app-level checks**, composite natural keys on listings,
char(1) enums, unsalted SHA1 passwords, settings split between file and DB, **no cron
(jobs piggybacked on page loads)**, HTML built in PHP strings.

### Wider survey (CES, Community Forge/Hamlets, Cyclos, IntegralCES, hOurworld, Sardex, Grassroots Economics/Sarafu, Encointer, Credit Commons)

Common baseline across platforms: member directory + join/approval workflow;
categorized offers/wants with expiry; zero-sum mutual-credit ledger with statements;
**configurable positive AND negative balance limits with per-user overrides**;
multi-community support (CES hosts hundreds of exchanges on one instance); role
systems (Hamlets: trader, committee, accountant, local admin, system); admin
analytics ("flag hoarders and long-term debtors" — repeatedly cited as the
under-served governance need); notification digests; per-exchange blog/announcements;
fee engines; **intertrading via gateway accounts**; data import/migration tools;
mobile/low-tech access (Cyclos: app, SMS, USSD, QR, NFC).

Differentiators worth noting:

- **Sardex** (B2B): credit limit ≈ 1% of member's annual turnover; **cap on positive
  balances** (~10% of turnover) as an anti-hoarding alternative to demurrage; paid
  human brokers matchmaking supply and demand.
- **Cyclos**: scripting engine for custom rules; REST/OpenAPI; multiple account and
  transaction types per currency; built-in demurrage/interest/fee engine.
- **Sarafu** (Kenya): joining grant at registration; **demurrage proceeds
  redistributed to active users** (community fund / UBI mechanism) rather than
  destroyed.
- **hOurworld**: inter-timebank transactions across 400+ timebanks; interest-matching
  engine; migration-in-a-day importers.
- **IntegralCES**: multi-currency with exchange rates between community currencies.
- Tauschring rule of thumb: cap the intertrading (gateway) account at ~10% of scheme
  activity to prevent liquidity crises.

---

## Part 2: Demurrage in practice

The plan's differentiator, and the least-specified part of it. Evidence:

| Scheme | Rate | Mechanics |
|---|---|---|
| Wörgl 1932 | 1%/month | Monthly stamp on notes; 9–10× circulation velocity vs schilling |
| Chiemgauer (paper) | 6%/yr (was 8%) | Renewal sticker per 6 months |
| Chiemgauer (digital) | 6%/yr | **Daily accrual** (≈0.016%/day) with a **90-day grace period** |
| Peanuts (Japan) | 1%/month | |
| Sarafu | 2%/month | Auto-collected, **redistributed to active users** |
| Encointer/Leu | started 5.6%/month, **community-voted down to 0.82%/month** | Continuous exponential decay per block |
| Cyclos | configurable | Scheduled account fee member→system: **rate %, period, free-base threshold** (only the excess above the free base is charged), computed on **time-weighted average balance** since last run |

Key design points:

- **Sign question.** Fiat-backed and token currencies demurrage positive holdings
  only. In pure mutual credit: positive-only demurrage breaks zero-sum *unless
  proceeds are recycled to a community account* (the plan's sweep does this);
  demurraging negative balances **rewards debtors**; symmetric decay of both signs
  toward zero forgives debtors and punishes creditors (controversial). Alternatives:
  Sardex-style positive caps + debt time limits. Douthwaite's variant: distinguish
  earned vs unearned units, tax only unearned.
- **Time-weighted average balance** since last posting, not point-in-time snapshots —
  snapshots are trivially gameable (spend the day before the sweep).
- **Grace period** (Chiemgauer: 90 days) and **free-base threshold** (Cyclos) soften
  the disincentive and protect small/new balances.
- Rates are politically sensitive — Leu's community voted theirs down 7×. Make rate,
  period, free base, and grace period per-currency parameters.
- Standard digital pattern: **daily accrual, periodic posting as ordinary ledger
  transactions** — keeps the sum-to-zero audit checkable at all times.

## Part 3: Inter-community exchange standards

- **Credit Commons Protocol** (Slater/Dini) — the open standard: federated ledgers in
  a fractal tree (leaf → branch → trunk), each node sovereign over policy; mirrored
  accounts between connected ledgers with chained hashes; multi-phase transaction
  workflow (create → validate downstream → commit); OpenAPI 3.0 spec; Node.js
  reference implementation (beta). Open issues: cross-node ordering, offline-node
  recovery, rounding at scale.
- **CES intertrading** — the de facto model: one gateway account per exchange holding
  the net external balance; Community Forge's "Clearing Central" interoperates.
- Practical cap: gateway account ≤ ~10% of scheme activity.

---

## Part 4: Proposed additions to the plan

### 4.1 Demurrage design (decision needed, not just a sweep)

Recommend: **positive-only demurrage, proceeds posted to the community account**,
per-currency parameters {rate, period, free-base threshold, grace period}, daily
accrual on time-weighted average balance, posted periodically as ordinary
transactions. Consider optional Sarafu-style redistribution and optional
Sardex-style positive caps / debt time limits as complementary levers.

### 4.2 Features supporting "credit control by social pressure"

The plan states the principle; these implement it:

- Transparency: balances, turnover, trading history visible to members (per-group
  toggle).
- Soft limits with staged escalation, not hard blocks: configurable flag thresholds
  (CamLETS: ±200 flag, ±400 review), per-member overrides, optional
  turnover-proportional limits (Sardex).
- Per-trade feedback (positive/neutral/negative + comment) with rebuttals and a
  percent-positive score.
- Admin restriction mechanism: block outward spending for persistent takers, with
  notifications.
- Dormancy/velocity/hoarder-and-debtor reports feeding the dashboard.

### 4.3 Workflow features every reference has

- **Invoicing / request-payment** in addition to push payments; **pending/confirmable
  payments** (opt-in accept/reject before posting); cancel-invoice; action-required
  counts in the UI.
- **Membership lifecycle**: online application → approval → renewal (fees split
  local-currency + sterling: dual-currency fee bookkeeping) → suspend → leave
  (residual balance → community account). Joint/household members; account types
  (individual, joint/household, organisation, business, community/system, gateway).
- **Proxy operation**: admin/treasurer/"buddy" acts for offline members ("login-as"
  with audit trail); batch entry of paper trading sheets from market events.
- **Email digests** of new/changed offers & wants (per-member frequency), full
  transactional email set, admin broadcast, notification preferences.
- **Marketplace**: listing expiry + auto-reactivation, holiday mode, photos,
  free-text or hourly rates, hierarchical categories, keyword + category + freshness
  + location filters (partial postcode / neighbourhood), public browse with
  members-only contact details, professional/qualified flags, auto-expiry of
  inactive members' listings with warning emails.
- **CMS-lite**: news/announcements, static info pages with per-page visibility
  (agreement, constitution, tax guidance), events calendar. Every LETS site is half
  community noticeboard.
- **Admin**: audit log of all admin actions; trade reversal as compensating
  transaction; service charge take + refund; settings editable in admin UI; backup
  and spreadsheet export; "never logged in" and timeframe trade reports.

### 4.4 Architectural decisions

- **Ledger**: append-only double-entry journal; balances derived or cached with
  invariant checks (the legacy denormalized balance column is the anti-pattern);
  integer minor units, never floats; reversals and demurrage are ordinary journal
  entries so audit-to-zero always holds; continuous sum-to-zero verification with
  alerting.
- **Payments**: idempotency keys on the QR/EPOS flow (double-scan protection);
  signed QR payload so amount/payee can't be tampered with.
- **Multi-tenancy**: decide now — one deployment per LETS (all four references) vs
  multi-group hosting (CES model; nobody offers this in the UK space; very hard to
  retrofit).
- **Federation**: reserve room in the account model for **gateway accounts** even if
  intertrading is deferred; target the Credit Commons protocol for the real thing;
  cap gateway exposure (~10% of activity).
- **API-first**: one REST/OpenAPI backend serving web UI, MCP server, and future
  mobile wrapper. MCP server needs per-member auth tokens with scopes (read
  marketplace vs make payments).
- **Scheduler**: real cron/job runner from day one (demurrage accrual, digests,
  listing expiry, renewal reminders). Legacy piggyback-on-page-load is the
  cautionary tale. Jobs must be idempotent.
- **Privacy**: field-level visibility tiers (public / members / admin) in the member
  model; GDPR consent, data export and delete.
- **Migration importers**: CSV/DB import of members, balances, listings from MCM and
  Local Exchange installs — the likely first adopters (Falmouth, CamLETS) run them.
- **Security**: modern password hashing, login lockout/rate limiting, CSRF — plus
  the planned 2FA/passkeys.

---

## Decisions

All nine decisions arising from this review have been made — see
[decisions.md](decisions.md):

1. **Demurrage semantics** — positive-only, marginal bands, monthly snapshot,
   proceeds to community account.
2. **Multi-tenancy** — tenant-keyed data model from the start; white-label SaaS
   deployment model.
3. **Credit-control levers** — pluggable policies: soft threshold flags, optional
   hard limits, manual restriction.
4. **Federation** — designed for (gateway account type, remote refs), not
   implemented.
5. **Pending-payment & invoicing model** — two-phase pending/committed;
   initiating is consenting; payer always authorises.
6. **Ledger representation** — normalised append-only journal, multi-currency
   legs with per-currency zero-sum, balances derived (caching is a storage-layer
   decision).
7. **Membership lifecycle & fees** — approval/removal flows; no fees (demurrage
   funds the community account); leavers settle to the community account.
8. **Reputation** — no per-trade ratings (evidence-based rejection); trade-count
   stats and admin-verified flags instead.
9. **MCP server auth** — per-membership scoped tokens; pending-by-default
   payments with human confirmation, autonomous pay as bounded opt-in.

## Sources

- [CamLETS](https://cam.letslink.org) · [Falmouth LETS](https://falmouthlets.uk/) ·
  [Mutual Credit Manager](https://www.mutualcreditmanager.co.uk/)
  ([GitHub](https://github.com/cdmweb/mutualcreditmanager)) ·
  [Local Exchange UK](https://github.com/cdmweb/Local-Exchange-UK)
- [CES](https://www.community-exchange.org/home/what-is-the-ces/) ·
  [Community Forge Hamlets](https://www.drupal.org/project/cforge) ·
  [Cyclos features](https://www.cyclos.org/features/) ·
  [Cyclos account fees](https://wiki.cyclos.org/index.php/Banking_-_Account_fees) ·
  [IntegralCES](https://integralces.net/) ·
  [hOurworld](https://hourworld.org/_TimeAndTalents.htm)
- [Credit Commons docs](https://credit-commons.gitlab.io/credit-commons-documentation/) ·
  [creditcommons.net](https://creditcommons.net/) ·
  [Matslats software review](https://matslats.net/ijccr-software-review) ·
  [Matslats on credit limits](https://matslats.net/mutual-credit-limits)
- [Sardex LSE study](https://eprints.lse.ac.uk/67135/7/Dini_From%20complimentary%20currency.pdf) ·
  [Chiemgauer](https://en.wikipedia.org/wiki/Chiemgauer) ·
  [Demurrage currency](https://en.wikipedia.org/wiki/Demurrage_currency) ·
  [Wörgl experiment](https://unterguggenberger.org/the-free-economy-experiment-of-woergl-1932-1933/) ·
  [Sarafu dataset paper](https://www.nature.com/articles/s41597-022-01539-4) ·
  [Grassroots Economics](https://grassrootseconomics.org/community-currencies) ·
  [Encointer demurrage](https://book.encointer.org/economics-demurrage.html)

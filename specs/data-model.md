# Silvio — Data Model Specification

Draft v0.3, 2026-07-10. Derives from [decisions.md](decisions.md) #1–#24; decision
numbers cited throughout. This is a logical model — concrete DDL belongs to the
storage implementation (#6: balance caching, indexing strategy etc. are the
storage layer's private decisions). Audited against the implemented SQLite
schema on 2026-07-10.

## Conventions

- **IDs**: UUIDv7 (time-ordered) primary keys everywhere. Sortable, opaque,
  merge-safe if instances are ever combined, and federation-friendly (#4).
- **Money**: signed 64-bit integers in **minor units**; `currency.scale` defines
  the decimal point. No floats in any money path (#6).
- **Rates**: integers in parts-per-million (ppm) — e.g. 1%/month = 10 000 ppm.
- **Tenancy**: every domain table carries `group_id`; all unique constraints are
  scoped by it (#2). Rows never reference rows of another group (enforced in the
  repository layer).
- **Timestamps**: UTC, `*_at` naming. Soft lifecycle via status + timestamp
  columns; the journal is the only append-only store — other entities may be
  updated but money history may not (#6).
- `JSON` columns are used only where a structure is policy-defined and opaque to
  the schema (pluggable credit-control config, #3).
- **Planned** markers: tables and fields tagged *(planned)* are specified here
  but not yet present in the implemented schema; everything else exists in the
  current migrations.

## Entity overview

```mermaid
erDiagram
    GROUP ||--o{ GROUP_DOMAIN : "resolved by hostname"
    GROUP ||--o{ MEMBER : has
    GROUP ||--o{ CURRENCY : issues
    GROUP ||--o{ CATEGORY : defines
    USER ||--o{ PERSON : "logs in as"
    MEMBER ||--|{ PERSON : "people on the account"
    MEMBER ||--o{ ACCOUNT : "one per currency used"
    CURRENCY ||--o{ ACCOUNT : denominates
    CURRENCY ||--o{ DEMURRAGE_BAND : "marginal bands"
    CURRENCY ||--o{ DEMURRAGE_RUN : "monthly postings"
    GROUP ||--o{ TRANSACTION : records
    GROUP ||--o{ CHECKPOINT : "monthly Merkle roots"
    CHECKPOINT ||--o{ WITNESS_RECEIPT : "published via Witnesses"
    TRANSACTION ||--|{ ENTRY : "legs (sum 0 per currency)"
    ACCOUNT ||--o{ ENTRY : "posted to"
    GROUP ||--o{ CREDIT_POLICY : activates
    CREDIT_POLICY ||--o{ POLICY_OVERRIDE : "per-member"
    CREDIT_POLICY ||--o{ ACCOUNT_FLAG : raises
    MEMBER ||--o{ LISTING : posts
    CATEGORY ||--o{ LISTING : categorises
    MEMBER ||--o{ API_TOKEN : "MCP access"
    GROUP ||--o{ AUDIT_EVENT : logs
    GROUP ||--o{ PAGE : publishes
    GROUP ||--o{ NEWS_ITEM : posts
    GROUP ||--o{ IMAGE : stores
    GROUP ||--o{ EMAIL_EVENT : queues
    GROUP ||--o{ EMAIL_TEMPLATE : overrides
```

## 1. Tenancy & identity (#2)

### group
| field | type | notes |
|---|---|---|
| id | uuid | |
| slug | text | unique; default subdomain |
| name | text | display name |
| status | text | active \| suspended — suspended = read-only, verification still runs (#20) |
| plan | text? | operator's free-text plan label (#20); a record, no billing logic |
| notes | text? | operator-private free text (#20); never serialised past operator routes |
| email_from | text? | per-group sender address (#16); delivery falls back to the instance default |
| settings | json? | group tunables, absent keys = platform defaults: auto-accept days (#5, 14), invoice expiry days (30), digest default (#17, weekly), listing shelf life days (#18, 180), transparency none \| balances (#19) |
| qr_secret | text | payment-request HMAC signing key (#22); never leaves the server |
| created_at | ts | |

Branding (logo, header background, #15) is not a column: brand images live in
the `image` table under owner kind `brand`, one per slot.

### group_domain
Hostname → tenant resolution for white-label custom domains.
`(hostname unique) → group_id`.

### user — global auth identity
| field | type | notes |
|---|---|---|
| id | uuid | |
| email | text | unique globally; login identifier |
| email_verified_at | ts? | set by the verify link or an accepted invite (#23) |
| password_hash | text | argon2id; becomes nullable when passkey-only login lands |
| totp_secret | text? | *(planned)* 2FA |
| is_operator | bool | platform super-admin (#2); never listed in groups |
| status | text | active \| locked \| closed |
| created_at, last_login_at | ts | login throttling/lockout is in-memory in the API layer, not persisted |

### passkey *(planned)*
WebAuthn credentials: `id, user_id, credential_id, public_key, sign_count,
label, created_at, last_used_at`.

### session
Server-side, revocable — **domain requirement**: suspension (#7), restriction
(#3) and logout take effect immediately, so no stateless JWTs. Opaque random
token, **sha256-hashed at rest** (unique): `id, user_id, token_hash, member_id?
(selected group context, #2), acting_member_id? (admin acts-for-member, #24),
created_at, expires_at, revoked_at?, last_seen_at (planned), client_info
(planned)`.

### one_time_token
Single-use expiring tokens, one table for all purposes: `id, user_id?, email,
purpose (password_reset | email_verify | invite), token_hash, expires_at,
used_at?`. Hashed at rest like sessions; `invite` carries joint-member
invitations (#23), user_id nullable because the user may not exist yet.

### member — a membership of a group (#2, #7)
| field | type | notes |
|---|---|---|
| id | uuid | |
| group_id | uuid | |
| member_no | int | per-group unique, human-friendly ("account number") |
| type | text | individual \| joint \| organisation |
| display_name | text | directory name |
| role | text | member \| committee \| admin (group-level; #2) |
| status | text | applied \| active \| away \| suspended \| closed (#7 lifecycle) |
| about | | *(planned)* profile text; the profile photo is not a column — it lives in the `image` table under owner kind `member` (#14) |
| neighbourhood | text? | free-text locality for directory filtering (CamLETS grid pattern); full address lives on person |
| digest_frequency | text | none \| weekly \| monthly — offers/wants digest (#17); default weekly |
| confirm_incoming | bool | opt-in payment confirmation (#5) |
| applied_at, approved_at, closed_at | ts? | applied_at not null |
| anonymised_at | ts? | *(planned)* GDPR erasure marker (#7): person/user data scrubbed, accounts persist |

### person — a human on a membership (#7)
| field | type | notes |
|---|---|---|
| id | uuid | |
| member_id | uuid | |
| user_id | uuid? | nullable — offline members have no login (buddy-managed) |
| is_primary | bool | one per member |
| name, email | text, text? | contact details |
| phones, address… | | *(planned)* further contact details |
| email_visibility, phone_visibility, address_visibility | text | *(planned)* members \| admin (field-level tiers; postcode shown partially to public is presentation policy) |

A `user` may be a `person` in many groups; a `member` may have several people
(joint/household). Notification preferences beyond the digest sit on person
(emails go to people).

## 2. Currency & demurrage (#1)

### currency
| field | type | notes |
|---|---|---|
| id | uuid | |
| group_id | uuid | |
| code | text | per-group unique, e.g. "CAM" |
| name | text | |
| symbol | text | *(planned)* |
| scale | int | decimal places (0 for whole units, the default); exposed to UIs via the accounts API |
| unit_name | text? | *(planned)* "hour" mode etc. |
| kind | text | *(planned)* mutual \| voucher \| bookkeeping — vouchers/mixed-fee currencies (#6); informational, same ledger rules |
| demurrage_day | int? | day-of-month (1–28) for posting run; null = demurrage off |
| rate_ref | json? | *(planned)* reserved: exchange-rate hint for federation (#4); no logic now |
| created_at | ts | |
| retired_at | ts? | *(planned)* |

### demurrage_band (#1)
Marginal, tax-like: `currency_id, from_amount (minor units),
rate_ppm_per_month` — no surrogate id; keyed `(currency_id, from_amount)` and
replaced as a set. Ordered by `from_amount`; first band typically 0 ppm
(free-base). Admin-editable; effective from next run.

### demurrage_run (#1)
Idempotency + audit for the monthly posting: `id, group_id, currency_id, period
("YYYY-MM", unique per currency), status (running | completed), started_at,
completed_at`. Each charge is a normal `transaction` (type `demurrage`,
`demurrage_run_id` set); re-running a completed period is a no-op, recovery
re-processes only accounts without a posted charge in the run.

## 3. Ledger (#5, #6)

### account
| field | type | notes |
|---|---|---|
| id | uuid | |
| group_id | uuid | |
| currency_id | uuid | an account holds exactly one currency — a leg's currency is implicit via its account (#6) |
| type | text | member \| community \| system \| gateway |
| member_id | uuid? | for member accounts; unique (member_id, currency_id) |
| counterparty_ref | text? | gateway accounts: which external group/node (#4) |
| created_at, closed_at | ts | closed accounts persist as ledger counterparties (#7) |

Exactly one `community` account per currency (demurrage proceeds #1, leaver
settlement #7). `gateway` accounts are demurrage- and policy-exempt (#1, #3).

### transaction (header)
| field | type | notes |
|---|---|---|
| id | uuid | |
| group_id | uuid | all legs' accounts belong to this group (#2, #6) |
| type | text | trade \| demurrage \| fee \| settlement \| reversal \| adjustment |
| flow | text? | payment \| invoice — who initiated, drives confirmation (#5) |
| state | text | pending \| committed \| declined \| cancelled \| expired (#5) |
| seq | int? | per-group chain index, assigned at commit — 1:1 with the hash chain (#10); statements order by it; verify() checks seq order == chain order |
| description, reference | text | member-entered |
| created_by | uuid | person id (or system) |
| channel | text | web \| mcp \| admin \| system |
| api_token_id | uuid? | when channel = mcp (#9 audit + rolling spend) |
| reverses_id | uuid? | compensating link (#5, #6) |
| demurrage_run_id | uuid? | (#1) |
| remote_ref | text? | opaque external ref for gateway trades (#4) |
| idempotency_key | text? | unique per group; replays return the original (#6) |
| hash, hash_version | text?, int? | journal hash chain (#10): set at commit. hash_version 1 = sha256 hex over canonical JSON of `{v, prev, id, group_id, type, seq, committed_at, entries sorted by account_id}` (prev = previous committed tx's hash, '' for the first); description/reference are not hashed. Domain logic (`ledger/hash.ts`), not a storage detail — every backend must produce identical hashes |
| created_at, committed_at, expires_at | ts | expiry for pending items (#5) |

### entry (legs)
`id, transaction_id, account_id, amount (signed bigint)`.

**Invariants (#6)**
1. Within a transaction, legs grouped by their account's currency each sum to
   zero — zero-sum by construction, per currency (multi-currency atomic swaps,
   vouchers, splits).
2. ≥ 2 legs; every leg's account in the header's group.
3. Committed transactions and their entries are immutable; only header `state`
   may transition, and only per the #5 state machine.
4. **Balances consider committed entries only.** Pending places no hold;
   credit-control authorisation (#3) runs at commit time.
5. Corrections are new transactions with `reverses_id` — never edits.
6. The hash chain (#10) is computed inside the same atomic commit that assigns
   `seq`; only committed transactions are chained.

### checkpoint (#10) *(planned)*
| field | type | notes |
|---|---|---|
| id | uuid | |
| group_id | uuid | |
| period | text | e.g. "2026-07"; unique per group; monthly, alongside the demurrage run |
| journal_head_hash | text | chain head at checkpoint time |
| merkle_root | text | tree over every account's (account_id, balance, last_entry_seq) |
| prev_checkpoint_hash | text | checkpoints chain too |
| created_at | ts | |

### witness_receipt (#10) *(planned)*
Pluggable **Witness** publications of checkpoint roots: `id, checkpoint_id,
witness_kind (newsletter | digest_email | git | peer_group | blockchain | …),
ref (URL/issue/peer checkpoint id), published_at`. Cross-group witnessing on a
multi-tenant instance records the witnessing group's own receipt as `ref`.

## 4. Credit control (#3)

### credit_policy
`id, group_id, currency_id, type (soft_threshold | hard_limit | …), config json,
enabled`. Config is policy-defined, e.g. soft_threshold:
`{thresholds: [{balance: -20000, level: "notice"}, {balance: -40000, level:
"review"}, {balance: 50000, level: "notice"}]}`; hard_limit:
`{min_balance, max_balance}`.

### policy_override *(planned)*
Per-member widening/narrowing: `id, policy_id, member_id, config json`.

### account_flag
Raised by periodic evaluation, never blocking by itself: `account_id,
member_id, level, reason`. Currently **computed, not stored** — the evaluator
derives flags from balances + policies on demand; persistence
(`raised_at, cleared_at?, policy_id`) is *(planned)* for history. Feeds
dashboards, directory badges (per group transparency settings), notifications,
dormancy review (#7).

### restriction
Manual admin lever: `id, member_id, reason, imposed_by, imposed_at, lifted_by?,
lifted_at?`. Active restriction denies outward payments at authorisation time;
earning stays open. Notifications + audit on impose/lift.

## 5. Marketplace

### category
`id, group_id, name, parent_id?` — per-group hierarchical taxonomy.

### listing
| field | type | notes |
|---|---|---|
| id | uuid | |
| group_id, member_id | uuid | |
| type | text | offer \| want |
| title, description | text | |
| category_id | uuid | |
| price_amount, price_currency_id | ?, uuid? | either a priced amount… |
| rate_text | text? | …or free-text ("negotiable", "10/hr") |
| badges | text[] | professional, qualified — **admin-verified** badges (#8); default [] |
| status | text | active \| hidden \| expired — hidden covers member `away` (#7) |
| expires_at | ts? | defaults to posting time + the group's listing shelf life (#18); owner renew resets it and revives within the purge window; purged 90 days after expiry |
| created_at, updated_at | ts | freshness filters |

Listing photos are `image` rows with owner kind `listing` (up to 5, ordered by
upload) — no separate listing_photo table.

### image (#14)
One general blob store, four owner kinds:
`id, group_id, owner_kind (cms | member | listing | brand), owner_id?, mime,
size, blob, created_by, created_at`. Bytes live in the blob column (SQLite
blobs first; a later backend may move them without touching the domain model)
and are served at `GET /i/{id}` with immutable caching — re-upload mints a new
id. The server validates only (magic-byte sniff, byte caps, per-owner count
limits, per-group quota); resizing is client-side. `member` = one profile
photo, `brand` = one image per slot (`logo` | `header`, #15), `cms` = images
referenced from page/news markdown.

Public browse shows listings without contact details; directory/contact data is
member-visibility (#2 settings, CamLETS pattern). Trade-count profile stats (#8)
are **computed from the journal**, not stored.

## 6. Content & communication

- **page**: `id, group_id, slug (unique per group), title, body, visibility
  (public | members | admin), position, created_at, updated_at` — CMS-lite
  (agreement, constitution, help). Body is markdown source (#13), rendered
  server-side at request time.
- **news_item**: `id, group_id, title, body (markdown), published_at,
  expires_at?, created_at, updated_at` — always public; current between
  published_at and expires_at.
- **email_event** (outbound queue + log): `id, group_id, person_id, kind,
  dedup_key (unique — idempotent enqueue, sweeps never double-send),
  to_email, subject, body (markdown source; rendered multipart at delivery,
  #16), from_email? (per-group sender snapshotted at enqueue), created_at,
  sent_at?, attempts, last_error?`.
- **email_template** (#16): `id, group_id, kind, subject, body` — unique
  `(group_id, kind)`; a row overrides the built-in default for that kind,
  deleting it reverts. Defaults live in code, never seeded.

Listing expiry/warning/purge, demurrage runs, pending-transaction sweeps,
digest generation (#17) and journal verification are scheduler jobs today;
dormancy evaluation joins them *(planned)* (architecture note in
first-review) — all idempotent, keyed by run records where money is involved.
Suspended groups (#20) get verification only.

## 7. API tokens (#9)

### api_token
| field | type | notes |
|---|---|---|
| id | uuid | |
| member_id | uuid | token acts as one membership (#9); no FK — loose linkage like accounts, so the ledger contract can use synthetic member ids |
| created_by | uuid | person |
| token_hash | text | sha256, unique; store hash only (like sessions) |
| label | text | member-chosen |
| scopes | text[] | marketplace:read, directory:read, account:read, listings:write, trade:request, trade:autonomous |
| max_tx_amount | int? | required when trade:autonomous |
| max_period_amount, period_days | int? | rolling spend cap (#9) |
| expires_at, revoked_at, last_used_at | ts? | |
| created_at | ts | |

Autonomous spend accounting is computed from the journal (`api_token_id` on
transactions) — no separate counter to drift.

## 8. Audit (#3, #7, #9)

### audit_event
`id, group_id? (null = platform-level), actor_user_id?, acting_for_member_id?
(acts-for-member, #24), action, entity_type, entity_id, detail json, at`.
Covers admin actions (approve, suspend, restrict, reverse, policy change,
act-as), operator group management (#20), person add/remove (#23), MCP
grants/revocations, and lifecycle transitions. Append-only.

## Uniqueness summary (all group-scoped, #2)

- group: slug; group_domain: hostname (global)
- user: email (global)
- member: member_no; account: (member_id, currency_id); one community account
  per currency
- currency: code; demurrage_band: (currency_id, from_amount);
  demurrage_run: (currency_id, period)
- transaction: idempotency_key; seq
- session: token_hash (global); api_token: token_hash (global);
  one_time_token: token_hash (global)
- email_event: dedup_key (global); email_template: (group_id, kind)
- page: slug
- checkpoint: (group_id, period) *(planned)*
- category: (parent_id, name)

## Storage interface sketch (#6)

The implemented contract lives in `server/src/storage/interface.ts`
(`Ledger` + the wider `Storage`); the ledger core:

```ts
interface Ledger {
  // Atomic: invariant checks, commit-time policy hooks (#3),
  // state transition, balance effects — all or nothing.
  post(tx: NewTransaction, idempotencyKey?: string): Promise<Transaction>;
  transition(txId: Id, to: TxState, actor: Actor): Promise<Transaction>;
  getTransaction(txId: Id): Promise<Transaction>;

  balance(accountId: Id): Promise<number>;               // committed only
  statement(accountId: Id): Promise<StatementLine[]>;    // ordered by seq, running balance
  verify(groupId: Id): Promise<VerifyReport>;            // recompute balances, hash chain,
                                                         // seq==chain order (#6, #10);
                                                         // mismatch = alert loudly
}
```

*(planned)* additions once checkpoints (#10) land — verify() then also checks
checkpoint roots:

```ts
checkpoint(groupId: Id, period: string): Promise<Checkpoint>;     // build + store (#10)
inclusionProof(accountId: Id, checkpointId: Id): Promise<Proof>;  // member-facing verify (#10)
```

The search interface is implemented (on `Storage`, same file):

```ts
// Generic full-text search over a domain, best match first; results respect
// the caller's tier (#2). How it's indexed (SQLite: an FTS5 table kept in
// sync by triggers) is the storage layer's private decision — same pattern
// as balances and images.
search(groupId: Id, domain: 'listings' | 'directory' | 'pages' | 'news',
       query: {
         text: string;                    // full-text over the domain's fields
         visibility: 'public' | 'member' | 'admin'; // caller's tier
         limit?: number; offset?: number;
       }): Promise<{ items: SearchResult[]; total: number }>;
```

Whether `balance()` derives, caches incrementally, or materialises is the
implementation's private decision; the contract is that it always equals the
sum of committed entries, atomically with respect to `post`.

## Resolved points

No open points remain.

(Resolved: sessions are server-side and revocable — suspension/logout must take
immediate effect — stored as opaque tokens hashed at rest; reset/verify/invite
tokens share one single-use `one_time_token` table. See §1.)

(Resolved: search is exposed as a generic search request over domains
(listings, directory, pages, news) with text + domain-specific filters +
caller visibility tier; indexing is the storage layer's private decision —
the SQLite implementation will use FTS5.)

(Resolved: `seq` is per-group, defined as the transaction's hash-chain position
(#10) — the chain is the authoritative order and seq is its projection. No
per-account numbering; statements order by group seq with running balances.)

# Working conventions for this repo

House rules for anyone (human or AI) changing Silvio. They were followed
throughout the initial build; keep them, or record a decision changing
them.

## Process

- **Test-first.** Write the failing test before the implementation. The
  failing test is the spec; make it pass without weakening it. Server
  behaviour is pinned at three levels: storage contract tests
  (`server/test/storage/contract.ts`, run against implementations via
  `sqlite.test.ts`), service tests, API tests via `app.inject`.
- **Decisions are recorded, never rewritten.** Design choices go in
  `specs/decisions.md` as sequentially numbered entries. Amending an old
  decision = a new decision plus an *(Amended by #n)* pointer at the old
  one. Parked work gets a `specs/plan-*.md` file, linked from
  `server/todo.md`.
- **`server/todo.md` is the tracking doc** — tick items with a short
  what-shipped note referencing the decision number.

## Schema policy — read this before touching schema.ts

**Pre-first-release** (current state): the v1 baseline `SCHEMA` in
`server/src/storage/sqlite/schema.ts` is edited directly — new tables and
columns go into the baseline, NOT new migrations. There are no deployed
databases to migrate.

**After the first real deployment, this flips**: the baseline freezes and
every change becomes a versioned migration (the machinery exists —
`schema_version`, migrations run on boot, a database newer than the build
is refused). Whoever ships the first production instance must also flip
this policy and delete this paragraph's first half.

## TypeScript

- `exactOptionalPropertyTypes` is on everywhere: build objects with
  conditional spreads / conditional assignment, never `field: undefined`.
- Plain `npm` per package — there is **no root package.json**; run
  commands inside `server/`, `cli/`, `ui/*`.

## The OpenAPI regeneration chain

Any change to server routes/schemas must ripple, in this order:

```
cd server && npm run build && npm run openapi   # dist → ui/shared/openapi.json
cd ui/shared && npm run generate && npm run build   # api-types.ts → dist
# then re-run tests in ui/member, ui/admin, ui/operator (file:../shared)
```

`ui/shared/src/types.ts` derives types from the generated file — never
hand-write an API shape.

## Response schemas are the leak guard

Every route declares a response schema; Fastify's serializer drops
anything undeclared, which is load-bearing: private fields (`qr_secret`,
operator `notes`) stay private because the shared schemas exclude them.
Component schemas in `server/src/api/schemas.ts` carry **drift guards**
(`Expect<Equal<FromSchema<...>, DomainType>>`) — a type/schema mismatch
fails `tsc`. Fields deliberately outside a shared schema use an inline
variant (see `PUBLIC_MEMBER_WITH_PHOTO`, `GROUP_WITH_NOTES`) with the
guard comparing against `Omit<...>`.

## Error conventions

`DomainError` codes map to HTTP in one handler (`app.ts`): INVALID→400,
NOT_FOUND→404, NOT_AUTHORISED/RESTRICTED/SUSPENDED/GROUP_SUSPENDED→403,
WRONG_STATE→409, LIMIT_BREACHED→422, RATE_LIMITED→429. StorageError:
NOT_FOUND→404, CONFLICT→409, else 400. Messages are member-facing. Never
build an oracle: unknown-vs-forbidden must look identical (404), and auth
failures share one message.

## Idioms worth keeping

- Comments state constraints the code can't, with decision refs (`(#14)`);
  no narration, no history.
- Services take `Storage` and throw `DomainError`; routes stay thin.
- Money is integer minor units end to end; scale applies only at display.
- Sweeps and notifications are idempotent by dedup key, never by memory —
  the scheduler tick can run any number of times.
- Tests use `new SqliteStorage(':memory:')`; anything slow or external is
  injectable (`limits`, `verifyCopy`, `alert`, `nowIso` parameters).
- Emails ride `email_events` with a dedup key and the #16 template
  pathway; a new notification kind means a new entry in
  `EMAIL_TEMPLATE_KINDS` (appended last — the list is pinned by tests)
  plus a label in the admin `EmailTemplatesPage`.

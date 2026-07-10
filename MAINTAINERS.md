# Maintainer's guide

Orientation for whoever picks Silvio up next — possibly cold, possibly
years from now. Working conventions (test-first, schema policy, the
OpenAPI regeneration chain) live in [CLAUDE.md](CLAUDE.md); this file is
the map and the operations manual.

## Read in this order

1. [README.md](README.md) — what and why, one paragraph of design.
2. [specs/plan.md](specs/plan.md) — the original functional plan.
3. [specs/decisions.md](specs/decisions.md) — **the core document**: 24
   sequential design decisions with rationale. Everything traces back
   here; the code comments cite them by number.
4. [specs/data-model.md](specs/data-model.md) — every table, with the
   ledger invariants.
5. [server/architecture.md](server/architecture.md) — layering and
   subsystem structure, with diagrams.
6. [server/todo.md](server/todo.md) — what shipped and what's parked;
   each parked item links a `specs/plan-*.md` file written to be picked
   up without re-deriving context.
7. [specs/first-review.md](specs/first-review.md) — the prior-art review
   of real LETS systems that the requirements came from.

## What runs where

One server process serves everything: REST API (`/api/v1`, tenancy by
Host header or `/g/{slug}`), server-rendered public brochure per group at
`/`, member PWA at `/app/`, group-admin app at `/admin/`, platform
operator console at `/operator/`, and an MCP endpoint for AI agents at
`{tenancy}/mcp`. One SQLite file is the whole state, images included.

## Day-to-day operations

- **Tests**: `npm test` inside each of `server/`, `cli/`, `ui/shared/`,
  `ui/member/`, `ui/admin/`, `ui/operator/`. The server suite is the big
  one (~500 tests); `test/api/lockout.test.ts` is slow by design (real
  argon2 under load). CI (`.github/workflows/docker.yml`) runs every
  suite and only publishes the image when they pass.
- **Release** = push to `main`: CI builds the Docker image and publishes
  `ghcr.io/sandtreader/silvio:latest` plus a commit-SHA tag. Deployment
  and backup/restore procedure: [deploy.md](deploy.md).
- **Demo**: `scripts/demo.sh` boots a throwaway instance and walks the
  full lifecycle — provisioning, members, listings, a month of trading,
  demurrage, restrictions — and doubles as an end-to-end smoke test.
- **Local dev**: server on :1862 (`npm run dev` equivalents per README);
  the UIs run under Vite with an `/api` proxy.

## Things that will bite you if you don't know them

- **The schema policy flips at first release** — see CLAUDE.md. Until
  then the v1 baseline schema is edited in place; after, migrations only.
- **The ledger is append-only and hash-chained** (decisions #6, #10).
  Corrections are reversal transactions, never edits. `verify()` runs on
  every scheduler tick and on demand; a failed verification is the
  loudest alarm the system has. Names and descriptions are deliberately
  outside the hash (see `specs/plan-gdpr.md` for why that matters).
- **Serializer as security boundary**: response schemas don't just
  document — they strip. Adding a field to a shared schema exposes it on
  every route that uses it. Private fields (group `qr_secret`, operator
  `notes`) are private *because* they're absent from schemas.
- **Tenancy is by Host header.** Behind a proxy, `Host` must pass through
  and `x-forwarded-proto` must be set or emailed links break.
- **`ui/shared` is consumed as a built artefact** (`file:../shared`) —
  after changing it, rebuild it (`npm run build`) or the apps keep using
  the stale dist.
- **Suspended groups are read-only, not gone** (#20) — and their journal
  is still verified on every tick, deliberately.
- **Rafiki apps (admin/operator) lose their session on reload** — known
  limitation, noted in both READMEs; a shared fix would benefit both.

## Where the bodies aren't buried

There is no hidden state: every admin action is in `audit_events`
(append-only), every email in `email_events`, every value movement in the
journal. When debugging, those three tables are the ground truth.

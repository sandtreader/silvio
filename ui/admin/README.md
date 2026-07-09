# @silvio/ui-admin

Desktop admin app for the Silvio LETS platform, built on the
[@sandtreader/rafiki](https://www.npmjs.com/package/@sandtreader/rafiki)
framework (React 18, MUI 5, Vite). Served at `/admin/` by the Silvio server
(`../../server`) in production.

Authentication is a custom Rafiki `AuthenticationProvider` over the server's
cookie-session API: the member's role maps to Rafiki capability globs
(role `admin` → `admin.*`), and each page in the menu declares the
capability it requires. Known limitation: a page reload loses the Rafiki
session even though the cookie survives (Rafiki has no restore hook yet).

## Pages

- **Approval queue** — members in the `applied` state with approve/reject
  actions (reject uses the API's `remove` action).
- **Members** — full member list with lifecycle actions (suspend, reinstate,
  remove), role changes, and manual payment restrictions.
  Limitation: the API has no way to list current restrictions, so both
  Restrict and Unrestrict are always offered.
- **Credit policies** — per-currency policy table with an enable/disable
  switch and an add dialog. Currency choices come from the group's public
  `GET /currencies` endpoint.
- **Demurrage bands** — per-currency marginal bands edited as a table of
  {from balance, % per month} and saved atomically as a whole.
- **Flags** — credit-control flags per currency (level + reason per member),
  the committee-review surface; flags never block by themselves.
- **Transactions** — search and list the group's transactions (text filter on
  description/reference via `GET /admin/transactions`), and reverse a committed
  one from its row after confirmation (a reversal is a compensating transaction
  linked via `reversesId`; pending/declined rows offer no reverse action).
- **Categories** — the marketplace category tree with add (name + optional
  parent) and inline rename.

## Prerequisite: build the shared library

This app depends on `@silvio/ui-shared` (`file:../shared`) for the typed API
client and money formatting; it must be built first:

```sh
cd ../shared && npm install && npm run build
```

## Development

```sh
npm install
npm run dev     # Vite dev server; proxies /api to http://localhost:1862
```

Run the Silvio server locally (see `../../server`) so the `/api` proxy has
something to talk to; the proxy keeps cookie sessions same-origin.

## Build, test, check

```sh
npm run build     # tsc --noEmit && vite build (base /admin/)
npm run preview   # serve the production build locally
npm test          # vitest run (jsdom)
npm run check     # tsc --noEmit
```

## License

AGPL-3.0-or-later — see [LICENSE.md](../../LICENSE.md) at the repository root.

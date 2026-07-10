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

- **Dashboard** — the group's health at a glance for one currency: balance
  distribution, monthly trade flow, velocity and dormant members.
- **Approval queue** — members in the `applied` state with approve/reject
  actions (reject uses the API's `remove` action).
- **Members** — full member list with lifecycle actions (suspend, reinstate,
  remove), role changes, manual payment restrictions, and "Act as…"
  (decision #24: the admin's session acts for the member; the member app
  shows an acting banner with a stop control). Restricted members are marked
  with a chip (reason on hover); Restrict is offered only to unrestricted
  members and Unrestrict only to restricted ones.
- **Credit policies** — per-currency policy table with an enable/disable
  switch and an add dialog. Currency choices come from the group's public
  `GET /currencies` endpoint.
- **Demurrage bands** — per-currency marginal bands edited as a table of
  {from balance, % per month} and saved atomically as a whole, plus the
  run history (period, status, timestamps per currency).
- **Flags** — credit-control flags per currency (level + reason per member),
  the committee-review surface; flags never block by themselves.
- **Transactions** — search and list the group's transactions (text filter on
  description/reference via `GET /admin/transactions`), and reverse a committed
  one from its row after confirmation (a reversal is a compensating transaction
  linked via `reversesId`; pending/declined rows offer no reverse action).
- **Audit log** — browse the group's append-only audit trail (who did what
  to which entity, newest first) with action and entity-id filters.
- **Categories** — the marketplace category tree with add (name + optional
  parent), inline rename, and delete (a category still in use prompts for a
  move-listings-to target).
- **Pages / News** — the brochure CMS (decision #13): markdown bodies edited
  with a live preview; the page with slug `home` is the brochure front page.
- **Images** — CMS image uploads (decision #14) with a
  copy-the-markdown-snippet affordance; images are downscaled client-side.
- **Branding** — group skinning (decision #15): the logo and header
  background slots with upload/replace/remove.
- **Email templates** — per-kind overrides of the built-in notification
  templates (decision #16): markdown with `{{placeholder}}` substitution and
  live preview, plus the per-group sender address.
- **Broadcast** — compose a markdown email and send it to every person on an
  active membership (decision #17), behind a confirmation.
- **Settings** — the group name and per-group tunables (`group.settings`):
  auto-accept days, invoice expiry days, listing shelf life, digest default,
  and the group-balances transparency toggle (decision #19).

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

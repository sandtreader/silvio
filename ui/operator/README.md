# @silvio/ui-operator

Desktop operator console for the Silvio LETS platform, built on the
[@sandtreader/rafiki](https://www.npmjs.com/package/@sandtreader/rafiki)
framework (React 18, MUI 5, Vite). Served at `/operator/` by the Silvio
server (`../../server`) in production (decision #21). The platform tier is
a different principal from group members: it has its own login
(`POST /api/v1/operator/login`) and host-independent routes, so the console
works on any hostname the server answers on.

Authentication is a custom Rafiki `AuthenticationProvider` over the
operator login; a successful login grants the static `operator.*`
capability that every menu entry requires — there is no finer capability
model at the platform tier. Known limitation (as in the admin app): a page
reload loses the Rafiki session even though the cookie survives.

## Pages

- **Groups** — all groups with status/plan, selecting into a management
  panel (decision #20): rename, suspend/reinstate (suspended = read-only
  for the group's members), plan label, operator-private notes, and
  custom-domain add/remove.
- **Provision group** — create a new tenant via `POST /operator/groups`:
  slug, name, optional hostname, its currency, and optionally an initial
  admin (an existing user by email is linked as-is; a new one gets a
  password and a welcome email).

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
npm run build     # tsc --noEmit && vite build (base /operator/)
npm run preview   # serve the production build locally
npm test          # vitest run (jsdom)
npm run check     # tsc --noEmit
```

## License

AGPL-3.0-or-later — see [LICENSE.md](../../LICENSE.md) at the repository root.

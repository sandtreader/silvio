# @silvio/ui-member

Mobile-first member-facing PWA for the Silvio LETS platform. React 19,
MUI 7, react-router 7, built with Vite and vite-plugin-pwa. Served at
`/app/` by the Silvio server (`../../server`); the app renders its own
slim brochure-style chrome (`SiteChrome`) from the public, session-aware
`GET /shell` endpoint (decision #15 — server-side injection was defeated
by the service worker). The app is logged-in-only — logged-out visitors
use the brochure site at the group root instead. Installable with an
auto-updating service worker scoped to `/app/`, so brochure pages,
`/admin` and `/api/` are never answered from the app's cache; the chrome
hides itself in the installed PWA (`display-mode: standalone`).

## Features

All routes are under `/app/` and, apart from Login and Apply, require
authentication.

- **Login / Apply** (`/app/login`, `/app/apply`) — email + password
  cookie-session login; membership application form (applications await
  admin approval).
- **Home** (`/app/`) — a balance card per account, a pending-actions chip
  linking to Activity, and the last five statement lines.
- **Market** (`/app/market`) — browse active listings filtered by
  All / Offers / Wants; post new listings via a FAB (title, description,
  category, optional price or rate text). The public marketplace browse
  lives on the brochure site.
- **Pay** (`/app/pay`) — three tabs:
  - *Scan*: camera QR scanning via the native `BarcodeDetector` API, with a
    paste-a-code fallback; decoded payment requests are confirmed in a
    bottom sheet and committed via `POST /payments`.
  - *Request*: generate a payment-request QR (payee, amount, optional
    reference) rendered with `qrcode`.
  - *Manual*: pick a member from the directory and pay directly.
- **Activity** (`/app/activity`) — pending transactions with accept /
  decline / cancel actions, followed by the full statement with running
  balance.
- **More** (`/app/more`) — profile, settings (confirm-incoming-payments
  toggle), member directory, logout.

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

With base `/app/` the dev server serves the app at
`http://localhost:5173/app/` (the bare root 404s). The chrome is
client-rendered from `GET /shell` (decision #15), which the dev proxy
forwards to the server; without a group resolving for the host it degrades
to no chrome.

Run the Silvio server locally (see `../../server`) so the `/api` proxy has
something to talk to; the proxy keeps cookie sessions same-origin.

## Build, test, check

```sh
npm run build     # production build to dist/
npm run preview   # serve the production build locally
npm test          # vitest run (jsdom)
npm run check     # tsc --noEmit
```

## License

AGPL-3.0-or-later — see [LICENSE.md](../../LICENSE.md) at the repository root.

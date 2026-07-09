# @silvio/ui-member

Mobile-first member-facing PWA for the Silvio LETS platform. React 19,
MUI 7, react-router 7, built with Vite and vite-plugin-pwa. Served at the
site root by the Silvio server (`../../server`) in production; installable
with an auto-updating service worker (the worker never answers `/admin` or
`/api/` requests).

## Features

- **Login / Apply** (`/login`, `/apply`) — email + password cookie-session
  login; membership application form (applications await admin approval).
  Logged-out visitors can still browse the market.
- **Home** (`/`) — a balance card per account, a pending-actions chip
  linking to Activity, and the last five statement lines.
- **Market** (`/market`, public) — browse active listings filtered by
  All / Offers / Wants; logged-in members post new listings via a FAB
  (title, description, category, optional price or rate text).
- **Pay** (`/pay`) — three tabs:
  - *Scan*: camera QR scanning via the native `BarcodeDetector` API, with a
    paste-a-code fallback; decoded payment requests are confirmed in a
    bottom sheet and committed via `POST /payments`.
  - *Request*: generate a payment-request QR (payee, amount, optional
    reference) rendered with `qrcode`.
  - *Manual*: pick a member from the directory and pay directly.
- **Activity** (`/activity`) — pending transactions with accept / decline /
  cancel actions, followed by the full statement with running balance.
- **More** (`/more`) — profile, settings (confirm-incoming-payments
  toggle), member directory, logout.

All routes except Market, Login and Apply require authentication.

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
npm run build     # production build to dist/
npm run preview   # serve the production build locally
npm test          # vitest run (jsdom)
npm run check     # tsc --noEmit
```

## License

AGPL-3.0-or-later — see [LICENSE.md](../../LICENSE.md) at the repository root.

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

All routes are under `/app/` and, apart from the auth pages, require
authentication.

- **Auth pages** (`/app/login`, `/app/apply`, `/app/forgot`, `/app/reset`,
  `/app/verify`, `/app/invite`) — email + password cookie-session login;
  membership application form (applications await admin approval); password
  reset request and completion, email-verification landing, and joint-member
  invite acceptance (decision #23) — the emailed links land on the last
  three.
- **Home** (`/app/`) — a balance card per account, a pending-actions chip
  linking to Activity, and the last five statement lines.
- **Market** (`/app/market`) — browse active listings filtered by
  All / Offers / Wants with a debounced full-text search box; post new
  listings via a FAB (title, description, category, optional price or rate
  text). Cards carry photo strips (owners manage up to 5 photos inline,
  decision #14) and admin-verified badges; owners see their listing's
  expiry with a one-tap renew (shelf life, decision #18). The public
  marketplace browse lives on the brochure site.
- **Pay** (`/app/pay`) — three tabs (decision #22: QR payloads are opaque
  and server-signed):
  - *Scan*: camera QR scanning via the native `BarcodeDetector` API, with a
    paste-a-code fallback; the payload is decoded server-side for a
    *verified* payee/amount, confirmed in a bottom sheet, and committed via
    `POST /payments/scan` (idempotent per payload).
  - *Request*: mint a signed payment-request QR via
    `POST /me/payment-requests` (amount optional — open for stall/donation
    codes), rendered with `qrcode`.
  - *Manual*: pick a member from the directory and pay directly.
- **Activity** (`/app/activity`) — pending transactions with accept /
  decline / cancel actions, then the statement with running balance, paged
  50 at a time, with a CSV download of the whole history.
- **More** (`/app/more`) — profile (photo upload, neighbourhood), settings
  (confirm-incoming-payments toggle, offers & wants digest cadence), member
  directory with neighbourhood filter, links to the pages below, logout.
- **Tokens** (`/app/tokens`, from More) — personal API tokens for MCP
  agents (decision #9): member-granted scopes, per-token spend caps for
  `trade:autonomous`; the raw token is shown exactly once.
- **Household** (`/app/household`, from More) — the persons sharing the
  membership (decision #23): add by email (existing accounts link, others
  get a 7-day invite), remove revokes access to this membership only.
- **Group balances** (`/app/balances`, from More) — every member's balance
  and 12-month turnover, only when the group publishes them (transparency
  setting, decision #19).

While an admin is acting for the member (decision #24) the app shows a
persistent "Acting for … — stop" banner.

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

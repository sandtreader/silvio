# App-shell chrome: known gap and options (resolved)

Status: **decided 2026-07-09** — option 1, client-rendered chrome, adopted
as decision #15 (specs/decisions.md). The React app renders its own slim
header from the public `GET /shell` endpoint; server-side injection into
the app's index.html is dropped. The analysis below is kept as the record
of why.

## What #12 intended

App routes under `/app/` are served wrapped in the same server-rendered
"shell chrome" as the brochure pages: group brand, page/news/market nav,
session corner (Log in / name + Open the app). Progressive chrome: full in
a desktop browser, slim on mobile, hidden in the installed PWA via
`@media (display-mode: standalone)`.

## What actually happens (observed in the browser, 2026-07-09)

The server side works: when the server serves an app route, the chrome is
correct and session-aware (nav includes members-visibility pages when
logged in, the session corner names the member). But two mechanisms defeat
it in practice:

1. **The service worker bypasses the server.** `vite-plugin-pwa` precaches
   the raw `dist/index.html` and its `NavigationRoute` answers every
   `/app/*` navigation from that cache once the SW controls the tab — i.e.
   every visit after the very first. The server's shell injection never
   runs, so the app renders with **no chrome at all**: no brand, no way
   back to the brochure.

2. **The chrome is static HTML.** Within one served page, SPA state changes
   don't touch it: log in inside the app and the header still says
   "Log in" until a full page load.

Net effect: the injected chrome appears only on a user's first-ever visit
(and possibly with the wrong session state afterwards). Brochure pages are
unaffected — server-rendered fresh every time, always correct.

## Options

### 1. Client-rendered chrome in the app (recommended when we pick this up)

The React app renders the same slim header itself: group name (and later
logo/header image, #12 skinning) from a small public endpoint, nav pages
from a viewer-aware endpoint or embedded shell data, session state from the
auth context it already has.

- Fixes both problems: present on every load (SW or server), always shows
  the true session state, works offline.
- Same standalone media query hides it in the installed PWA.
- Honours #12's "the app renders in the brochure, not linked from it".
- Cost: the chrome exists twice (server template for brochure pages, React
  component for the app) and must stay visually in step; needs a public
  shell-info endpoint (group name + viewer-visible nav pages).
- Server-side injection into index.html can then be dropped entirely.

### 2. Accept a chrome-less app

Drop the injection; the chrome becomes brochure-only. Add an in-app route
back to the site (e.g. a link on More). Simplest, most honest about what a
PWA is — but a desktop-browser app tab loses the brochure framing #12
asked for.

### 3. Network-first app navigations

Configure the SW so navigations go to the network first and fall back to
the cached shell only offline. Chrome then appears on every browser
page-load — but the stale-login-state problem remains, and every
navigation pays a network round trip, hurting the app feel.

## Evidence

Reproduce with any built deployment (`scripts/demo.sh` or the smoke
pattern in the session notes):

- First visit to `/app/login` in a fresh profile → chrome present.
- Log in (SPA) → header still says "Log in" (option-2 symptom).
- Reload → SW now controls; chrome gone entirely (option-1 symptom).
- Brochure pages (`/`, `/p/...`, `/market`, `/news`) → always correct.

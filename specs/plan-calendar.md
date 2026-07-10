# Plan: Events calendar

Parked from [server/todo.md](../server/todo.md) Later/speculative — "needs a
data-model decision first". Decisions referenced: #12 (brochure), #13
(markdown), #17 (digest), #2 (per-group).

## Why

First-review: "every LETS site is half community noticeboard", and events
are its beating heart — CamLETS runs monthly trading events whose paper
trading sheets the proxy flow (#24) exists to serve; Falmouth's observed
gaps include "no events RSVP". Trading events are where LETS trading
actually happens; the calendar is how members find them.

## Current state

- CMS-lite shipped: `pages` + `news_items` (markdown #13, brochure
  rendering #12), so today an event is a news item with a date in the
  title — no structure, no ordering by when, no "upcoming" view.
- Digest (#17) and brochure shell exist as surfacing channels.
- No event entity; this is the data-model §6 decision the todo defers.

## Proposed design

- **The data-model decision to make first**: is an event (a) a news_item
  subtype (add `starts_at` to news — cheap, but conflates announce-once
  with recurring listings and pollutes the noticeboard), or (b) its own
  entity (clean queries: upcoming, past, calendar month). Recommend (b);
  ratify as a numbered decision before building.
- **event** table sketch: `id, group_id, title, body (markdown, #13
  pathway), starts_at, ends_at?, location (free text — matches the
  deliberately-simple neighbourhood posture), visibility (public |
  members — reuse the pages tiers), created_by, created_at, updated_at,
  cancelled_at?`. No image in v1 (CMS images can live in the body via the
  #14 allowlist).
- **No RSVP in v1.** The references show groups *wanting* RSVP
  (first-review, Falmouth gaps) but v1 keeps events read-only:
  RSVP means attendee lists, capacity, reminders, privacy questions —
  a second feature. The entity leaves room (an `event_rsvps` table later
  adds cleanly); revisit when a pilot group asks. Open question below.
- **Recurring events: punt.** Admins re-post monthly events; a "duplicate
  event" button is 90% of the value of recurrence rules at 2% of the
  cost. RRULE machinery is explicitly out.
- **Surfacing**:
  - Brochure `/events` (#12 pattern, like `/news`): upcoming list,
    visibility-tiered; past events drop off (retain rows, filter by date).
  - Digest (#17): "coming up" section — events starting within the next
    period window, alongside new listings.
  - Member app: More → Events (or fold into a combined noticeboard view).
  - Admin CRUD reusing the news_items editor pattern (markdown + preview).
- **Cancellation, not deletion**: cancelled events render struck-through
  while upcoming (members may have planned around them), purge with the
  past.

## Implementation sketch (TDD slices)

1. Ratify the entity decision (decisions.md entry — human sign-off).
2. Storage: `events` table + CRUD + upcoming/past queries; migration.
3. API: admin CRUD routes + public/member list routes (visibility-tiered,
   schema'd like news).
4. Brochure `/events` page; admin UI page (news editor pattern).
5. Digest "coming up" section (template placeholder, #16/#17 pathway).
6. Member app Events view.

## Open questions

- News subtype vs own entity (recommendation: own entity) — the blocking
  decision.
- RSVP in scope for v1 after all? If a pilot group's first request is
  trading-event headcounts, building the entity without it twice is waste.
- Visibility: do public events belong on the brochure for recruitment
  (leaning yes — open trading events are how groups recruit)?
- iCal export (`/events.ics`) — trivially cheap, real member value; v1 or
  later?
- Time zones: store UTC + render in group-local (one group setting), or
  naive local times? (Single-country groups make naive tempting; UTC is
  safer.)

## Dependencies / parked until

None technical — all supporting pathways (#12, #13, #16, #17) shipped.
Parked on the entity decision plus a pilot group to say whether RSVP
matters. Cheap to build once decided.

Referenced from server/todo.md's parked list.

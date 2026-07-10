// API response types, derived from the generated OpenAPI types
// (src/api-types.ts, regenerated from openapi.json via `npm run generate`).
// The server publishes full response schemas, so everything here is a
// re-export or projection of the generated shapes — no hand-written copies.
// Local aliases keep the names the UIs already import (e.g. DirectoryMember
// for the wire schema PublicMember, Policy for CreditPolicy).

import type { components, paths } from './api-types.js';

type Schemas = components['schemas'];

export type Id = string;

// --- Entities as the API returns them --------------------------------------

export type Group = Schemas['Group'];
/** Per-group tunables; absent keys fall back to platform defaults. */
export type GroupSettings = NonNullable<Group['settings']>;
export type Currency = Schemas['Currency'];

/** Full member record (own /me, and admin listings). */
export type Member = Schemas['Member'];

/** Directory projection: public profile fields only (GET /members). Derived
 * from the path response, which carries photoId (decision #14) that the named
 * PublicMember schema does not. */
export type DirectoryMember =
  paths['/api/v1/members']['get']['responses']['200']['content']['application/json']['members'][number];

/** Trade-count profile stats (decision #8), returned by GET /members/:id. */
export type TradeStats = Schemas['TradeStats'];

export type Entry = Schemas['Entry'];
export type Transaction = Schemas['Transaction'];

/** A pending transaction from this member's point of view (decision #5). */
export type PendingItem = Schemas['PendingItem'];

export type StatementLine = Schemas['StatementLine'];

export type Category = Schemas['Category'];
export type Listing = Schemas['Listing'];

export type ApiToken = Schemas['ApiToken'];

/** One person on a (joint) membership (#23); no userId means their invite
 * is still outstanding. */
export type Person = Schemas['Person'];
/** Member-grantable MCP/API token scope (decision #9). */
export type ApiScope = ApiToken['scopes'][number];

// --- CMS content (decision #13) -----------------------------------------------

/** CMS page: body is markdown source, rendered server-side on the brochure. */
export type Page = Schemas['Page'];
export type PageVisibility = Page['visibility'];

/** CMS news item: body is markdown source, like Page. */
export type NewsItem = Schemas['NewsItem'];

/** Stored image metadata (decision #14); the blob itself serves at GET /i/{id}. */
export type Image = Schemas['Image'];

/** Group skin slot (decision #15): one brand image per slot. */
export type BrandSlot =
  paths['/api/v1/admin/branding/{slot}']['put']['parameters']['path']['slot'];

/** GET /shell response (#15): everything the member app's client-rendered
 * chrome needs — group identity, branding image ids, the viewer's visible
 * nav pages, and the logged-in member's name (absent when logged out). */
export type ShellInfo =
  paths['/api/v1/shell']['get']['responses']['200']['content']['application/json'];

// --- Email templates (decision #16) -------------------------------------------

/** Effective template for one notification kind: the group's override or the
 * built-in default (isDefault). Subject and body carry {{placeholder}}s. */
export type EmailTemplate =
  paths['/api/v1/admin/email-templates']['get']['responses']['200']['content']['application/json']['templates'][number];
export type EmailTemplateKind = EmailTemplate['kind'];

// --- Credit control (decision #3) -------------------------------------------

export type Policy = Schemas['CreditPolicy'];
export type CreditPolicyConfig = Policy['config'];
export type SoftThreshold = NonNullable<CreditPolicyConfig['thresholds']>[number];

export type Restriction = Schemas['Restriction'];

/** GET /admin/flags item (computed, never blocking by itself). */
export type Flag = Schemas['AccountFlag'];

// --- Search (#18) ---------------------------------------------------------------

/** One GET /search hit: the domain it came from, the entity id, and a title
 * (plus an optional matched-text snippet). */
export type SearchResult = Schemas['SearchResult'];
export type SearchDomain = SearchResult['domain'];

// --- Dashboard stats ------------------------------------------------------------

/** GET /admin/stats response: per-member balance distribution (sorted by
 * balance, descending), monthly trade flow (ascending, gap months absent),
 * 30-day velocity and dormant members — all for one currency. Amounts are
 * integer minor units at that currency's scale. */
export type AdminStats =
  paths['/api/v1/admin/stats']['get']['responses']['200']['content']['application/json'];

// --- Operator console (decision #21) -------------------------------------------

/** Group as the operator routes return it: Group plus notes, always with
 * status and (optionally) plan. */
export type OperatorGroup =
  paths['/api/v1/operator/groups']['get']['responses']['200']['content']['application/json']['groups'][number];

/** PATCH /operator/groups/{id} body: null clears plan/notes. */
export type OperatorGroupPatch =
  paths['/api/v1/operator/groups/{id}']['patch']['requestBody']['content']['application/json'];

// --- Signed payment requests (decision #22) -------------------------------------

/** POST /me/payment-requests body: mint a signed, opaque QR payload. */
export type PaymentRequestInput =
  paths['/api/v1/me/payment-requests']['post']['requestBody']['content']['application/json'];

/** GET /payment-requests/decode response: the *server-verified* contents of a
 * scanned payload — payee name included, so the confirm screen can trust it. */
export type DecodedPaymentRequest =
  paths['/api/v1/payment-requests/decode']['get']['responses']['200']['content']['application/json'];

// --- Audit log ----------------------------------------------------------------

/** One audit-log event (GET /admin/audit): dotted action (e.g.
 * member.approve), the entity it touched, and a small free-form detail. */
export type AuditEvent = Schemas['AuditEvent'];

// --- Demurrage (decision #1) -------------------------------------------------

export type DemurrageBand = Schemas['DemurrageBand'];

// --- Envelope shapes ----------------------------------------------------------

/** GET /me response. */
export type Me =
  paths['/api/v1/me']['get']['responses']['200']['content']['application/json'];

/** One account in the GET /me response, balance included. */
export type AccountSummary = Schemas['AccountBalance'];

/** One row of the group balances transparency view (GET /balances, #19). */
export type GroupBalance =
  paths['/api/v1/balances']['get']['responses']['200']['content']['application/json']['balances'][number];

// --- Domain enums, derived from the entity shapes ----------------------------

export type TxType = Transaction['type'];
export type TxState = Transaction['state'];
export type TxFlow = NonNullable<Transaction['flow']>;
export type Channel = Transaction['channel'];

export type MemberStatus = Member['status'];
export type MemberType = Member['type'];
export type MemberRole = Member['role'];

/** Offers & wants digest cadence (decision #17). */
export type DigestFrequency = Member['digestFrequency'];

export type CreditPolicyType = Policy['type'];

export type ListingType = Listing['type'];
export type ListingStatus = Listing['status'];

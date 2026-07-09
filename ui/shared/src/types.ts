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
export type Currency = Schemas['Currency'];

/** Full member record (own /me, and admin listings). */
export type Member = Schemas['Member'];

/** Directory projection: public profile fields only (GET /members). */
export type DirectoryMember = Schemas['PublicMember'];

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

// --- CMS content (decision #13) -----------------------------------------------

/** CMS page: body is markdown source, rendered server-side on the brochure. */
export type Page = Schemas['Page'];
export type PageVisibility = Page['visibility'];

/** CMS news item: body is markdown source, like Page. */
export type NewsItem = Schemas['NewsItem'];

/** Stored image metadata (decision #14); the blob itself serves at GET /i/{id}. */
export type Image = Schemas['Image'];

// --- Credit control (decision #3) -------------------------------------------

export type Policy = Schemas['CreditPolicy'];
export type CreditPolicyConfig = Policy['config'];
export type SoftThreshold = NonNullable<CreditPolicyConfig['thresholds']>[number];

export type Restriction = Schemas['Restriction'];

/** GET /admin/flags item (computed, never blocking by itself). */
export type Flag = Schemas['AccountFlag'];

// --- Demurrage (decision #1) -------------------------------------------------

export type DemurrageBand = Schemas['DemurrageBand'];

// --- Envelope shapes ----------------------------------------------------------

/** GET /me response. */
export type Me =
  paths['/api/v1/me']['get']['responses']['200']['content']['application/json'];

/** One account in the GET /me response, balance included. */
export type AccountSummary = Schemas['AccountBalance'];

// --- Domain enums, derived from the entity shapes ----------------------------

export type TxType = Transaction['type'];
export type TxState = Transaction['state'];
export type TxFlow = NonNullable<Transaction['flow']>;
export type Channel = Transaction['channel'];

export type MemberStatus = Member['status'];
export type MemberType = Member['type'];
export type MemberRole = Member['role'];

export type CreditPolicyType = Policy['type'];

export type ListingType = Listing['type'];
export type ListingStatus = Listing['status'];

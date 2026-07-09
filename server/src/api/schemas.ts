// Named JSON Schemas for API responses (todo: API polish). Each schema is
// registered once at app level via app.addSchema() and referenced from route
// `response` sections as { $ref: 'Name#' }; @fastify/swagger publishes them
// as #/components/schemas/{Name}. Two jobs at once: the OpenAPI document
// carries response types for client generation, and Fastify's serializer
// (fast-json-stringify) becomes a structural leak guard — any field not
// declared here is never sent.
//
// Drift guards at the bottom statically assert (via json-schema-to-ts) that
// each domain-shape schema serializes exactly its src/types.ts type: an added
// or removed or retyped field fails `tsc --noEmit`.

import type { FromSchema } from 'json-schema-to-ts';
import type {
  AccountFlag,
  ApiToken,
  Category,
  CreditPolicy,
  Currency,
  DemurrageBand,
  Entry,
  Group,
  Image,
  Listing,
  Member,
  NewsItem,
  Page,
  Restriction,
  StatementLine,
  TradeStats,
  Transaction,
} from '../types.js';
import type { PendingItem, PublicMember } from './app.js';

// Enum values mirror the string unions in src/types.ts; the drift guards
// below fail compilation if either side changes without the other.
const TX_TYPE = ['trade', 'demurrage', 'fee', 'settlement', 'reversal', 'adjustment'] as const;
const TX_STATE = ['pending', 'committed', 'declined', 'cancelled', 'expired'] as const;
const TX_FLOW = ['payment', 'invoice'] as const;
const CHANNEL = ['web', 'mcp', 'admin', 'system'] as const;
const MEMBER_STATUS = ['applied', 'active', 'away', 'suspended', 'closed'] as const;
const MEMBER_TYPE = ['individual', 'joint', 'organisation'] as const;
const MEMBER_ROLE = ['member', 'committee', 'admin'] as const;
const LISTING_TYPE = ['offer', 'want'] as const;
const PAGE_VISIBILITY = ['public', 'members', 'admin'] as const;
const LISTING_STATUS = ['active', 'hidden', 'expired'] as const;
const CREDIT_POLICY_TYPE = ['soft_threshold', 'hard_limit'] as const;
const IMAGE_OWNER_KIND = ['cms', 'member', 'listing', 'brand'] as const;
const API_SCOPE = [
  'marketplace:read',
  'directory:read',
  'account:read',
  'listings:write',
  'trade:request',
  'trade:autonomous',
] as const;

// The bodies are separate consts (no $id) so json-schema-to-ts can derive
// their types without reference resolution; the exported schemas add the $id
// Fastify and swagger key on. Money fields are integer minor units
// (decision #6), hence { type: 'integer' } throughout.

const GROUP = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'name', 'createdAt'],
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

const CURRENCY = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'code', 'name', 'scale', 'createdAt'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    scale: { type: 'integer' },
    demurrageDay: { type: 'integer' },
    createdAt: { type: 'string' },
  },
} as const;

const ENTRY = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'transactionId', 'accountId', 'amount'],
  properties: {
    id: { type: 'string' },
    transactionId: { type: 'string' },
    accountId: { type: 'string' },
    amount: { type: 'integer' },
  },
} as const;

const TRANSACTION = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'type', 'state', 'createdBy', 'channel', 'createdAt', 'entries'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    type: { type: 'string', enum: TX_TYPE },
    flow: { type: 'string', enum: TX_FLOW },
    state: { type: 'string', enum: TX_STATE },
    seq: { type: 'integer' },
    hash: { type: 'string' },
    hashVersion: { type: 'integer' },
    description: { type: 'string' },
    reference: { type: 'string' },
    createdBy: { type: 'string' },
    channel: { type: 'string', enum: CHANNEL },
    reversesId: { type: 'string' },
    demurrageRunId: { type: 'string' },
    remoteRef: { type: 'string' },
    apiTokenId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    createdAt: { type: 'string' },
    committedAt: { type: 'string' },
    expiresAt: { type: 'string' },
    entries: { type: 'array', items: ENTRY },
  },
} as const;

const MEMBER = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'groupId',
    'memberNo',
    'type',
    'role',
    'displayName',
    'status',
    'confirmIncoming',
    'appliedAt',
  ],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    memberNo: { type: 'integer' },
    type: { type: 'string', enum: MEMBER_TYPE },
    role: { type: 'string', enum: MEMBER_ROLE },
    displayName: { type: 'string' },
    status: { type: 'string', enum: MEMBER_STATUS },
    confirmIncoming: { type: 'boolean' },
    appliedAt: { type: 'string' },
    approvedAt: { type: 'string' },
    closedAt: { type: 'string' },
    // Derived from the images table, populated at the API layer (#14 phase 2).
    photoId: { type: 'string' },
  },
} as const;

// Directory projection (app.ts): public profile fields only. The test suite
// pins these five properties — private settings must never be declared.
const PUBLIC_MEMBER = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'memberNo', 'displayName', 'type', 'status'],
  properties: {
    id: { type: 'string' },
    memberNo: { type: 'integer' },
    displayName: { type: 'string' },
    type: { type: 'string', enum: MEMBER_TYPE },
    status: { type: 'string', enum: MEMBER_STATUS },
  },
} as const;

// Directory entries also carry a derived photoId (#14 phase 2). A separate
// schema, used inline by the /members routes, so the pinned PublicMember
// component above stays exactly the five public profile fields while the
// serializer still keeps photoId (it drops anything undeclared).
export const PUBLIC_MEMBER_WITH_PHOTO = {
  ...PUBLIC_MEMBER,
  properties: {
    ...PUBLIC_MEMBER.properties,
    photoId: { type: 'string' },
  },
} as const;

const PENDING_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'amount', 'direction', 'actions'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: TX_TYPE },
    flow: { type: 'string', enum: TX_FLOW },
    amount: { type: 'integer' },
    direction: { type: 'string', enum: ['in', 'out'] },
    description: { type: 'string' },
    expiresAt: { type: 'string' },
    actions: {
      type: 'array',
      items: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
    },
  },
} as const;

const STATEMENT_LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['seq', 'transactionId', 'type', 'amount', 'runningBalance', 'committedAt'],
  properties: {
    seq: { type: 'integer' },
    transactionId: { type: 'string' },
    type: { type: 'string', enum: TX_TYPE },
    description: { type: 'string' },
    reference: { type: 'string' },
    amount: { type: 'integer' },
    runningBalance: { type: 'integer' },
    committedAt: { type: 'string' },
  },
} as const;

// API-layer projection returned by GET /me: one row per member account with
// its currency denormalised for display.
const ACCOUNT_BALANCE = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'currencyId', 'currencyCode', 'scale', 'balance'],
  properties: {
    id: { type: 'string' },
    currencyId: { type: 'string' },
    currencyCode: { type: 'string' },
    scale: { type: 'integer' },
    balance: { type: 'integer' },
  },
} as const;

const TRADE_STATS = {
  type: 'object',
  additionalProperties: false,
  required: ['trades', 'partners'],
  properties: {
    trades: { type: 'integer' },
    partners: { type: 'integer' },
    lastTradeAt: { type: 'string' },
  },
} as const;

const LISTING = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'groupId',
    'memberId',
    'type',
    'title',
    'description',
    'categoryId',
    'status',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    memberId: { type: 'string' },
    type: { type: 'string', enum: LISTING_TYPE },
    title: { type: 'string' },
    description: { type: 'string' },
    categoryId: { type: 'string' },
    priceAmount: { type: 'integer' },
    priceCurrencyId: { type: 'string' },
    rateText: { type: 'string' },
    status: { type: 'string', enum: LISTING_STATUS },
    expiresAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    // Derived from the images table, populated at the API layer (#14 phase 3).
    photoIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

const CATEGORY = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'name'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    parentId: { type: 'string' },
  },
} as const;

const API_TOKEN = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'memberId', 'createdBy', 'label', 'scopes', 'createdAt'],
  properties: {
    id: { type: 'string' },
    memberId: { type: 'string' },
    createdBy: { type: 'string' },
    label: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string', enum: API_SCOPE } },
    maxTxAmount: { type: 'integer' },
    maxPeriodAmount: { type: 'integer' },
    periodDays: { type: 'integer' },
    expiresAt: { type: 'string' },
    revokedAt: { type: 'string' },
    lastUsedAt: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

const CREDIT_POLICY = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'currencyId', 'type', 'config', 'enabled'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    currencyId: { type: 'string' },
    type: { type: 'string', enum: CREDIT_POLICY_TYPE },
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thresholds: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['balance', 'level'],
            properties: {
              balance: { type: 'integer' },
              level: { type: 'string' },
            },
          },
        },
        minBalance: { type: 'integer' },
        maxBalance: { type: 'integer' },
      },
    },
    enabled: { type: 'boolean' },
  },
} as const;

const DEMURRAGE_BAND = {
  type: 'object',
  additionalProperties: false,
  required: ['fromAmount', 'ratePpmPerMonth'],
  properties: {
    fromAmount: { type: 'integer' },
    ratePpmPerMonth: { type: 'integer' },
  },
} as const;

// CMS page (decision #13): body is markdown source; rendering happens at the
// brochure edge, so the API round-trips the source verbatim.
const PAGE = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'groupId',
    'slug',
    'title',
    'body',
    'visibility',
    'position',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    visibility: { type: 'string', enum: PAGE_VISIBILITY },
    position: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

// News item (decision #13): the community noticeboard — always public, shown
// from publishedAt until expiresAt. body is markdown source, rendered on the
// brochure, so the API round-trips the source verbatim.
const NEWS_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'title', 'body', 'publishedAt', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    publishedAt: { type: 'string' },
    expiresAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

// Image metadata (decision #14): the API only ever carries metadata — the
// bytes are served by GET /i/{id}, outside the JSON API.
const IMAGE = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'ownerKind', 'mime', 'size', 'createdBy', 'createdAt'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    ownerKind: { type: 'string', enum: IMAGE_OWNER_KIND },
    ownerId: { type: 'string' },
    mime: { type: 'string' },
    size: { type: 'integer' },
    createdBy: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

const RESTRICTION = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'memberId', 'reason', 'imposedBy', 'imposedAt'],
  properties: {
    id: { type: 'string' },
    memberId: { type: 'string' },
    reason: { type: 'string' },
    imposedBy: { type: 'string' },
    imposedAt: { type: 'string' },
    liftedBy: { type: 'string' },
    liftedAt: { type: 'string' },
  },
} as const;

const ACCOUNT_FLAG = {
  type: 'object',
  additionalProperties: false,
  required: ['accountId', 'memberId', 'level', 'reason'],
  properties: {
    accountId: { type: 'string' },
    memberId: { type: 'string' },
    level: { type: 'string' },
    reason: { type: 'string' },
  },
} as const;

// The one error shape (app.ts errorBody / the shared error handler).
const ERROR_RESPONSE = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

/** Trivial acknowledgement body ({ ok: true }); inlined, not a component. */
export const OK_RESPONSE = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
} as const;

/** Every shared schema, registered once via app.addSchema() (app level, not
 * inside the twice-registered tenancy plugin — duplicate $id would throw). */
export const sharedSchemas = [
  { $id: 'Group', ...GROUP },
  { $id: 'Currency', ...CURRENCY },
  { $id: 'Entry', ...ENTRY },
  { $id: 'Transaction', ...TRANSACTION },
  { $id: 'Member', ...MEMBER },
  { $id: 'PublicMember', ...PUBLIC_MEMBER },
  { $id: 'PendingItem', ...PENDING_ITEM },
  { $id: 'StatementLine', ...STATEMENT_LINE },
  { $id: 'AccountBalance', ...ACCOUNT_BALANCE },
  { $id: 'TradeStats', ...TRADE_STATS },
  { $id: 'Listing', ...LISTING },
  { $id: 'Category', ...CATEGORY },
  { $id: 'ApiToken', ...API_TOKEN },
  { $id: 'CreditPolicy', ...CREDIT_POLICY },
  { $id: 'DemurrageBand', ...DEMURRAGE_BAND },
  { $id: 'Page', ...PAGE },
  { $id: 'NewsItem', ...NEWS_ITEM },
  { $id: 'Image', ...IMAGE },
  { $id: 'Restriction', ...RESTRICTION },
  { $id: 'AccountFlag', ...ACCOUNT_FLAG },
  { $id: 'ErrorResponse', ...ERROR_RESPONSE },
] as const;

// --- Drift guards -----------------------------------------------------------
// Exact structural equality between what a schema serializes (FromSchema) and
// the domain type: extra, missing, or retyped properties all fail tsc. The
// classic conditional-type identity trick distinguishes optionality and
// (under exactOptionalPropertyTypes) `field?: T` from `field?: T | undefined`.

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _DriftGuards = [
  Expect<Equal<FromSchema<typeof GROUP>, Group>>,
  Expect<Equal<FromSchema<typeof CURRENCY>, Currency>>,
  Expect<Equal<FromSchema<typeof ENTRY>, Entry>>,
  Expect<Equal<FromSchema<typeof TRANSACTION>, Transaction>>,
  Expect<Equal<FromSchema<typeof MEMBER>, Member>>,
  // PublicMember's photoId lives in the WITH_PHOTO variant (#14 phase 2), so
  // that schema is the one guarded against the interface.
  Expect<Equal<FromSchema<typeof PUBLIC_MEMBER_WITH_PHOTO>, PublicMember>>,
  Expect<Equal<FromSchema<typeof PENDING_ITEM>, PendingItem>>,
  Expect<Equal<FromSchema<typeof STATEMENT_LINE>, StatementLine>>,
  Expect<Equal<FromSchema<typeof TRADE_STATS>, TradeStats>>,
  Expect<Equal<FromSchema<typeof LISTING>, Listing>>,
  Expect<Equal<FromSchema<typeof CATEGORY>, Category>>,
  Expect<Equal<FromSchema<typeof API_TOKEN>, ApiToken>>,
  Expect<Equal<FromSchema<typeof CREDIT_POLICY>, CreditPolicy>>,
  Expect<Equal<FromSchema<typeof DEMURRAGE_BAND>, DemurrageBand>>,
  Expect<Equal<FromSchema<typeof PAGE>, Page>>,
  Expect<Equal<FromSchema<typeof NEWS_ITEM>, NewsItem>>,
  Expect<Equal<FromSchema<typeof IMAGE>, Image>>,
  Expect<Equal<FromSchema<typeof RESTRICTION>, Restriction>>,
  Expect<Equal<FromSchema<typeof ACCOUNT_FLAG>, AccountFlag>>,
];

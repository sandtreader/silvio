// REST API (Fastify). Tenancy per decision #2: the group is resolved from the
// Host header (white-label custom domains via group_domains) with a
// /g/{slug} path prefix as the host-independent fallback. Sessions are opaque
// cookies backed by the auth service; DomainErrors map to HTTP statuses in
// one shared handler; @fastify/swagger serves an OpenAPI document.

import Fastify from 'fastify';
import type {
  FastifyError,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import type {
  AuditEventFilter,
  SearchQuery,
  Storage,
  TransactionFilter,
} from '../storage/interface.js';
import type {
  ApiScope,
  ApiToken,
  Category,
  BrandSlot,
  CreditPolicyConfig,
  CreditPolicyType,
  DemurrageBand,
  DigestFrequency,
  Group,
  GroupSettings,
  GroupStatus,
  Id,
  Image,
  ListingType,
  Member,
  MemberRole,
  MemberStatus,
  MemberType,
  NewsItem,
  Page,
  PageVisibility,
  SearchDomain,
  Session,
  TxFlow,
  TxType,
  User,
} from '../types.js';
import { demurrageCharge, nextPostingDate } from '../ledger/demurrage.js';
import { DomainError, type DomainErrorCode } from '../services/errors.js';
import { StorageError } from '../storage/errors.js';
import { authenticate, login, logout, register, verifyCredentials } from '../services/auth.js';
import {
  requestPasswordReset,
  resetPassword,
  sendEmailVerification,
  verifyEmail,
} from '../services/recovery.js';
import { acceptInvite, addPerson, removePerson } from '../services/persons.js';
import { provisionGroup } from '../services/provisioning.js';
import { apply, approve, leave, reinstate, suspend } from '../services/membership.js';
import {
  accept,
  cancel,
  decline,
  requestPayment,
  reverse,
  sendPayment,
} from '../services/trading.js';
import { authenticateApiToken, checkTokenCaps, issueApiToken } from '../services/tokens.js';
import {
  decodePaymentRequest,
  mintPaymentRequest,
  scanPayment,
} from '../services/paymentrequest.js';
import { recordAudit } from '../services/audit.js';
import { dashboardStats } from '../services/stats.js';
import {
  GROUP_STATUS,
  GROUP_WITH_NOTES_AND_DOMAINS,
  OK_RESPONSE,
  PUBLIC_MEMBER_WITH_PHOTO,
  SEARCH_DOMAIN,
  TRANSPARENCY,
  sharedSchemas,
} from './schemas.js';
import { effectiveSettings } from '../services/settings.js';
import { evaluateFlags } from '../services/creditcontrol.js';
import {
  notifyRestrictionImposed,
  notifyRestrictionLifted,
} from '../services/notifications.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KINDS,
  type EmailTemplateKind,
} from '../services/emailtemplates.js';
import { browse, postListing, renewListing } from '../services/marketplace.js';
import {
  addListingPhoto,
  brandingFor,
  deleteBrandImage,
  deleteMemberPhoto,
  listingPhotoIds,
  removeListingPhoto,
  setBrandImage,
  setMemberPhoto,
  uploadImage,
} from '../services/images.js';
import { LoginThrottle } from '../services/ratelimit.js';
import { buildMcpServer, type RestClient } from '../mcp/server.js';
import {
  SESSION_COOKIE,
  navPagesFor,
  registerBrochureRoutes,
  sessionMember,
  sessionMemberContext,
} from './brochure.js';
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

declare module 'fastify' {
  interface FastifyRequest {
    group?: Group;
    // Exactly one of session (cookie) or token (bearer, decision #9) is set.
    // While acting for a member (#24) member is the target and
    // actingForMemberId is set; user stays the admin (attribution never lies).
    auth?: {
      user: User;
      session?: Session;
      member: Member;
      token?: ApiToken;
      actingForMemberId?: Id;
    };
    // Set by requireOperator (#20): the operator user, for audit actor ids.
    operator?: User;
  }
  interface FastifyContextConfig {
    // Routes opt in to API-token access by listing acceptable scopes
    // (decision #9); routes without a scopes config are cookie-only.
    scopes?: ApiScope[];
    // Opt out of the CSRF Origin check: only for cookie-free endpoints
    // whose worst cross-site effect is bounded elsewhere (/auth/forgot —
    // an email to the account owner, throttled).
    skipOriginCheck?: boolean;
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  WRONG_STATE: 409,
  NOT_AUTHORISED: 403,
  RESTRICTED: 403,
  SUSPENDED: 403,
  GROUP_SUSPENDED: 403,
  LIMIT_BREACHED: 422,
  RATE_LIMITED: 429,
};

/** Methods that can change state and therefore need the CSRF origin check. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

type ResolveGroup = (request: FastifyRequest) => Promise<Group | undefined>;

const ID_PARAM_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
} as const;

// Response-schema plumbing (todo: API polish): success shapes reference the
// shared schemas in schemas.ts; every route also documents the one error
// shape under '4XX' so clients see it in the OpenAPI document. The '4XX'
// serializer doubles as a guarantee that error bodies stay { error: { code,
// message } } and nothing else.
const ERROR_REF = { $ref: 'ErrorResponse#' } as const;

function ref(name: string): { $ref: string } {
  return { $ref: `${name}#` };
}

function arrayOf(name: string): object {
  return { type: 'array', items: ref(name) };
}

/** An object response body; all listed properties required unless overridden. */
function body(
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
): object {
  return { type: 'object', additionalProperties: false, required, properties };
}

/** The `response` section for a route: one success status + shared errors. */
function respond(status: number, schema: object): Record<string, object> {
  return { [status]: schema, '4XX': ERROR_REF };
}

// --- statement CSV export --------------------------------------------------

const CSV_HEADER = 'Date,Type,Description,Reference,Amount,Balance';

/** Quote a CSV field when it contains a comma, quote, or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Integer minor units -> plain decimal at the currency's scale (e.g. 1.00). */
function scaledAmount(minor: number, scale: number): string {
  if (scale === 0) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const unit = 10 ** scale;
  return `${sign}${Math.floor(abs / unit)}.${String(abs % unit).padStart(scale, '0')}`;
}

/** Directory projection: public profile fields only (no private settings). */
export interface PublicMember {
  id: string;
  memberNo: number;
  displayName: string;
  type: MemberType;
  status: MemberStatus;
  // Derived from the images table, populated at the API layer (#14 phase 2).
  photoId?: string;
}

function publicMember(member: Member, photoId?: string): PublicMember {
  const view: PublicMember = {
    id: member.id,
    memberNo: member.memberNo,
    displayName: member.displayName,
    type: member.type,
    status: member.status,
  };
  if (photoId !== undefined) view.photoId = photoId;
  return view;
}

/** A pending transaction from one member's point of view (decision #5). */
export interface PendingItem {
  id: string;
  type: TxType;
  flow?: TxFlow;
  amount: number; // absolute amount of this member's leg
  direction: 'in' | 'out';
  description?: string;
  expiresAt?: string;
  actions: ('accept' | 'decline' | 'cancel')[];
}

export interface BuildAppOptions {
  ui?: {
    memberDist?: string; // built member app, served at /app/ (decision #12)
    adminDist?: string; // built admin app, served at /admin/
    operatorDist?: string; // built operator console, served at /operator/ (#21)
  };
  // Per-token request allowance (decision #9). The default (60 requests a
  // minute) is deliberately generous: this is an anti-runaway guard against
  // a looping agent, not a usage quota.
  tokenRateLimit?: { maxRequests?: number; windowMs?: number };
}

export async function buildApp(
  storage: Storage,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  // removeAdditional off: additionalProperties:false must 400 on unknown
  // keys (e.g. group settings), not silently strip them.
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });

  // Raw image upload bodies (decision #14): the whole image/* range parses
  // as a Buffer so every claimed image type reaches the upload service,
  // whose magic-byte whitelist is the real gate — an unregistered subtype
  // would bounce as an unhelpful 415 before validation could say why. The
  // CSRF hook below is onRequest, so it still runs before any body parsing.
  app.addContentTypeParser(
    /^image\/.*/,
    { parseAs: 'buffer' },
    (_request, payload, done) => done(null, payload),
  );

  // CSRF defence in depth (todo: "CSRF protection for cookie sessions").
  // Sessions are already SameSite=Lax, which blocks cross-site POSTs in
  // modern browsers; this Origin check on state-changing /api/* requests is
  // a second layer. Only the host is compared — behind a TLS-terminating
  // proxy the server cannot see the browser's scheme, so scheme is
  // deliberately ignored. No Origin header (CLI, curl, server-to-server) is
  // allowed; a mismatched or unparseable browser Origin is rejected.
  app.addHook('onRequest', async (request, reply) => {
    if (!STATE_CHANGING.has(request.method)) return undefined;
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/api/')) return undefined;
    // Routing precedes onRequest, so per-route opt-outs are visible here.
    if (request.routeOptions.config?.skipOriginCheck === true) return undefined;
    const origin = request.headers.origin;
    if (origin === undefined) return undefined;
    let originHost: string;
    try {
      originHost = new URL(origin).host; // 'null' and garbage both throw
    } catch {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'request origin is not acceptable'));
    }
    const host = request.headers.host ?? '';
    // Default ports are equivalent to none (and scheme is ignored, so both
    // 80 and 443 count): 'localhost' and 'localhost:80' are the same host.
    const normalise = (value: string): string => value.toLowerCase().replace(/:(80|443)$/, '');
    if (normalise(originHost) !== normalise(host)) {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'request origin does not match this host'));
    }
    return undefined;
  });

  // Login throttling (todo: "Login lockout / rate limiting on auth
  // endpoints"): sliding windows per email (targeted guessing) and per IP
  // (spraying many emails). Both login routes share the same helper.
  const emailThrottle = new LoginThrottle(); // 10 failures / 15 minutes
  const ipThrottle = new LoginThrottle({ maxFailures: 30 }); // same window

  /**
   * Wrap a credential check with lockout accounting: 429 + Retry-After when
   * either key is throttled, a failure recorded on both keys when the check
   * throws NOT_AUTHORISED, and the email counter cleared on success.
   */
  async function checkThrottled<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    email: string,
    verify: () => Promise<T>,
  ): Promise<T> {
    const emailKey = `email:${email.toLowerCase()}`;
    const ipKey = `ip:${request.ip}`;
    const now = Date.now();
    const waitMs = Math.max(
      emailThrottle.retryAfterMs(emailKey, now),
      ipThrottle.retryAfterMs(ipKey, now),
    );
    if (waitMs > 0) {
      // Set before throwing: Fastify preserves reply headers through the
      // error handler.
      reply.header('retry-after', Math.max(1, Math.ceil(waitMs / 1000)));
      throw new DomainError('RATE_LIMITED', 'too many failed login attempts; try again later');
    }
    let result: T;
    try {
      result = await verify();
    } catch (err) {
      if (err instanceof DomainError && err.code === 'NOT_AUTHORISED') {
        const failedAt = Date.now();
        emailThrottle.recordFailure(emailKey, failedAt);
        ipThrottle.recordFailure(ipKey, failedAt);
      }
      throw err;
    }
    emailThrottle.recordSuccess(emailKey); // the IP counter is left alone
    return result;
  }

  // Forgot-password throttles (data-model §1): separate instances from the
  // login pair — every forgot request counts as a "failure", so sharing the
  // login counters would let a mail-bomber lock the victim's login too.
  const forgotEmailThrottle = new LoginThrottle(); // 10 requests / 15 minutes
  const forgotIpThrottle = new LoginThrottle({ maxFailures: 30 }); // same window

  /** 429 + Retry-After past the cap; otherwise count this request and go on. */
  function checkForgotThrottled(request: FastifyRequest, reply: FastifyReply, email: string): void {
    const emailKey = `email:${email.toLowerCase()}`;
    const ipKey = `ip:${request.ip}`;
    const nowMs = Date.now();
    const waitMs = Math.max(
      forgotEmailThrottle.retryAfterMs(emailKey, nowMs),
      forgotIpThrottle.retryAfterMs(ipKey, nowMs),
    );
    if (waitMs > 0) {
      reply.header('retry-after', Math.max(1, Math.ceil(waitMs / 1000)));
      throw new DomainError('RATE_LIMITED', 'too many reset requests; try again later');
    }
    forgotEmailThrottle.recordFailure(emailKey, nowMs);
    forgotIpThrottle.recordFailure(ipKey, nowMs);
  }

  /** Where emailed links point back at: this request's scheme://host, with
   *  default ports dropped (the CSRF check's normalisation, applied here so
   *  links never carry a redundant :80/:443). */
  function baseUrlFrom(request: FastifyRequest): string {
    const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const host = (request.headers.host ?? '').replace(/:(80|443)$/, '');
    return `${proto}://${host}`;
  }

  await app.register(cookie);
  await app.register(swagger, {
    openapi: { info: { title: 'Silvio', version: '0.1' } },
    // Name components after each schema's $id instead of the def-N default,
    // so the document exposes #/components/schemas/Member etc.
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${i}`,
    },
  });

  // Shared response schemas, registered once at app level: the tenancy
  // plugin below is registered twice, and a duplicate $id would throw.
  for (const schema of sharedSchemas) app.addSchema(schema);

  // Same-origin UI serving, revised by decision #12: the brochure owns /,
  // the member app's assets live under /app/, admin stays at /admin/, and
  // /api/* is never swallowed by any fallback. index: false on the member
  // dist so /app/ navigations fall through to the shell-wrapped index below
  // rather than the raw file.
  const memberDist = opts.ui?.memberDist;
  const adminDist = opts.ui?.adminDist;
  const operatorDist = opts.ui?.operatorDist;

  // The member app's index.html, read once and served untouched (#15,
  // amending #12's shell injection): the service worker answers every
  // post-first-visit /app/* navigation from its precached raw index.html, so
  // injection never reaches the user; the app renders its own chrome from
  // the public GET /shell endpoint instead.
  let memberIndexCache: string | undefined;
  async function serveAppShell(dist: string, reply: FastifyReply): Promise<unknown> {
    memberIndexCache ??= await readFile(join(dist, 'index.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(memberIndexCache);
  }

  if (memberDist !== undefined) {
    // index: false so the wildcard never serves the raw index.html; the
    // explicit /app/ route below wins over the static /app/* wildcard and
    // deep links fall through to the not-found handler — both the same index.
    await app.register(fastifyStatic, { root: memberDist, prefix: '/app/', index: false });
    app.get('/app/', { schema: { hide: true } }, (_request, reply) =>
      serveAppShell(memberDist, reply));
  }
  if (adminDist !== undefined) {
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: '/admin/',
      decorateReply: memberDist === undefined,
    });
  }
  if (operatorDist !== undefined) {
    await app.register(fastifyStatic, {
      root: operatorDist,
      prefix: '/operator/',
      // decorateReply only on the first fastify-static registration
      decorateReply: memberDist === undefined && adminDist === undefined,
    });
  }

  // Public brochure site (decision #12): server-rendered / and /market,
  // registered whether or not the built member app is available.
  registerBrochureRoutes(app, storage);

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (request.method === 'GET' && !path.startsWith('/api/')) {
      if (adminDist !== undefined && path.startsWith('/admin')) {
        return reply.sendFile('index.html', adminDist);
      }
      if (operatorDist !== undefined && path.startsWith('/operator')) {
        return reply.sendFile('index.html', operatorDist);
      }
      if (memberDist !== undefined && path.startsWith('/app')) {
        return serveAppShell(memberDist, reply);
      }
    }
    return reply.status(404).send(errorBody('NOT_FOUND', `no such route: ${path}`));
  });

  app.setErrorHandler((err: FastifyError, _request, reply) => {
    if (err instanceof DomainError) {
      return reply
        .status(DOMAIN_STATUS[err.code])
        .send(errorBody(err.code, err.message));
    }
    if (err instanceof StorageError) {
      if (err.code === 'NOT_FOUND') {
        return reply.status(404).send(errorBody('NOT_FOUND', err.message));
      }
      if (err.code === 'CONFLICT') {
        // Uniqueness violations, e.g. a duplicate page slug (#13).
        return reply.status(409).send(errorBody('CONFLICT', err.message));
      }
      return reply.status(400).send(errorBody('INVALID', err.message));
    }
    if (err.validation) {
      return reply.status(400).send(errorBody('INVALID', err.message));
    }
    app.log.error(err);
    return reply.status(500).send(errorBody('INTERNAL', 'internal server error'));
  });

  // Per-token rate limiting (decision #9): LoginThrottle's sliding window
  // counts "failures" per key; here every authenticated request is recorded,
  // so maxFailures doubles as the request allowance. Cookie sessions are
  // untouched. MCP traffic is covered too: each tool call re-injects into
  // the REST layer with the bearer header and lands in requireTokenMember —
  // only the /mcp handshake itself goes uncounted (see mcpHandler).
  const tokenThrottle = new LoginThrottle({
    maxFailures: opts.tokenRateLimit?.maxRequests ?? 60,
    windowMs: opts.tokenRateLimit?.windowMs ?? 60_000,
  });

  /**
   * Bearer token -> live auth context (decision #9): the token acts as its
   * member, the acting user resolved via the issuing person, and access is
   * gated by the route's scopes config — cookie-only routes reject tokens.
   */
  async function requireTokenMember(
    request: FastifyRequest,
    reply: FastifyReply,
    raw: string,
  ): Promise<unknown> {
    const result = await authenticateApiToken(storage, raw); // unknown/revoked/expired
    if (!result) {
      return reply
        .status(401)
        .send(errorBody('NOT_AUTHORISED', 'a valid API token is required'));
    }
    const { token, member } = result;
    // Count every authenticated request against the token id (decision #9);
    // over the allowance the reply is 429 with the same Retry-After idiom as
    // checkThrottled.
    const nowMs = Date.now();
    const waitMs = tokenThrottle.retryAfterMs(token.id, nowMs);
    if (waitMs > 0) {
      reply.header('retry-after', Math.max(1, Math.ceil(waitMs / 1000)));
      return reply
        .status(429)
        .send(errorBody('RATE_LIMITED', 'this token has used its request allowance; slow down'));
    }
    tokenThrottle.recordFailure(token.id, nowMs);
    if (member.groupId !== request.group!.id) {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'this token belongs to another group'));
    }
    // The acting user is the person who issued the token; a token cannot
    // outlive its issuer's link to the membership.
    const persons = await storage.personsForMember(token.memberId);
    const person = persons.find((candidate) => candidate.id === token.createdBy);
    if (!person || person.userId === undefined) {
      return reply
        .status(401)
        .send(errorBody('NOT_AUTHORISED', 'the person who issued this token is gone'));
    }
    const user = await storage.getUser(person.userId);
    const scopes = request.routeOptions.config.scopes;
    if (scopes === undefined) {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'this route is not available to API tokens'));
    }
    if (!scopes.some((scope) => token.scopes.includes(scope))) {
      return reply
        .status(403)
        .send(
          errorBody(
            'NOT_AUTHORISED',
            `this token lacks the required scope (needs ${scopes.join(' or ')})`,
          ),
        );
    }
    request.auth = { user, member, token };
    return undefined;
  }

  /** Session cookie -> live auth context in this request's group; 401/403 otherwise. */
  async function requireMember(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    // A Bearer header takes precedence over any cookie (decision #9).
    const authorization = request.headers.authorization;
    if (authorization !== undefined && authorization.startsWith('Bearer ')) {
      return requireTokenMember(request, reply, authorization.slice('Bearer '.length));
    }
    const token = request.cookies[SESSION_COOKIE];
    const context = token === undefined ? undefined : await authenticate(storage, token);
    if (!context || !context.member) {
      return reply
        .status(401)
        .send(errorBody('NOT_AUTHORISED', 'a valid session is required'));
    }
    const member = await storage.getMember(context.member.id); // fresh, not cached
    if (member.groupId !== request.group!.id) {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'this session belongs to another group'));
    }
    request.auth = { user: context.user, session: context.session, member };
    if (context.actingForMemberId !== undefined) {
      request.auth.actingForMemberId = context.actingForMemberId;
    }
    return undefined;
  }

  /** Runs after requireMember: group-level admin role (decision #2). */
  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (request.auth!.member.role !== 'admin') {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'this action requires the admin role'));
    }
    return undefined;
  }

  /** Runs after requireMember: escalation paths are shut while acting (#24). */
  async function refuseWhileActing(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    if (request.auth!.actingForMemberId !== undefined) {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'not available while acting for a member'));
    }
    return undefined;
  }

  /** All group-scoped routes; registered once per tenancy resolution mode. */
  const routes =
    (resolveGroup: ResolveGroup): FastifyPluginAsync =>
    async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        const group = await resolveGroup(request);
        if (!group) {
          return reply.status(404).send(errorBody('NOT_FOUND', 'unknown group'));
        }
        request.group = group;
        // Suspension (#20): read-only. The route pattern minus this plugin's
        // prefix is the in-plugin path — the concrete request.url cannot be
        // used because the /g/:slug prefix varies per request. /auth/* stays
        // open (account access is user-level, not group-level), and /mcp
        // passes through: its re-injected REST calls hit this same hook, so
        // writes stay blocked while read tools keep working.
        if (group.status === 'suspended' && STATE_CHANGING.has(request.method)) {
          const inPlugin = (request.routeOptions.url ?? '').slice(scope.prefix.length);
          if (!inPlugin.startsWith('/auth/') && inPlugin !== '/mcp') {
            return reply
              .status(403)
              .send(errorBody(
                'GROUP_SUSPENDED',
                'this group is currently suspended; contact its operator',
              ));
          }
        }
        return undefined;
      });

      scope.post(
        '/auth/login',
        {
          schema: {
            body: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: { type: 'string' },
                password: { type: 'string' },
              },
            },
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request, reply) => {
          const body = request.body as { email: string; password: string };
          const { token } = await checkThrottled(request, reply, body.email, () =>
            login(storage, {
              email: body.email,
              password: body.password,
              groupId: request.group!.id,
            }),
          );
          reply.setCookie(SESSION_COOKIE, token, {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
          });
          return { ok: true };
        },
      );

      scope.post(
        '/auth/logout',
        { schema: { response: respond(200, OK_RESPONSE) } },
        async (request, reply) => {
          const token = request.cookies[SESSION_COOKIE];
          if (token !== undefined) await logout(storage, token);
          reply.clearCookie(SESSION_COOKIE, { path: '/' });
          return { ok: true };
        },
      );

      // Password reset & email verification (data-model §1). forgot always
      // answers ok — whether the email has an account is never disclosed.
      scope.post(
        '/auth/forgot',
        {
          // Cookie-free by design, so the Origin check does not apply; the
          // per-email/IP throttle bounds what a cross-site POST can do.
          config: { skipOriginCheck: true },
          schema: {
            body: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string' } },
            },
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request, reply) => {
          const body = request.body as { email: string };
          checkForgotThrottled(request, reply, body.email);
          await requestPasswordReset(storage, {
            groupId: request.group!.id,
            email: body.email,
            baseUrl: baseUrlFrom(request),
          });
          return { ok: true };
        },
      );

      scope.post(
        '/auth/reset',
        {
          schema: {
            body: {
              type: 'object',
              required: ['token', 'password'],
              properties: {
                token: { type: 'string' },
                password: { type: 'string' },
              },
            },
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const body = request.body as { token: string; password: string };
          await resetPassword(storage, body.token, body.password);
          return { ok: true };
        },
      );

      // Joint members (#23): accept an emailed invite — creates the login,
      // links the person(s), and counts as email verification.
      scope.post(
        '/auth/accept-invite',
        {
          schema: {
            body: {
              type: 'object',
              required: ['token', 'password'],
              properties: {
                token: { type: 'string' },
                password: { type: 'string' },
              },
            },
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const body = request.body as { token: string; password: string };
          await acceptInvite(storage, body.token, body.password);
          return { ok: true };
        },
      );

      scope.post(
        '/auth/verify',
        {
          schema: {
            body: {
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string' } },
            },
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const body = request.body as { token: string };
          await verifyEmail(storage, body.token);
          return { ok: true };
        },
      );

      // Shell info (#15): the public, session-aware data the member app's
      // client-rendered chrome is built from — group identity, branding
      // image ids, the viewer's visible nav pages, and who is logged in.
      // Public because the chrome shows before login, session-aware so the
      // nav honours page visibility tiers (#13).
      scope.get(
        '/shell',
        {
          schema: {
            response: respond(
              200,
              body(
                {
                  group: body({ name: { type: 'string' }, slug: { type: 'string' } }),
                  // Branding keys and member are present only when set
                  // (exactOptionalPropertyTypes end to end).
                  branding: body(
                    {
                      logoImageId: { type: 'string' },
                      headerImageId: { type: 'string' },
                    },
                    [],
                  ),
                  navPages: {
                    type: 'array',
                    items: body({ slug: { type: 'string' }, title: { type: 'string' } }),
                  },
                  // acting (true) only while acting for the member (#24).
                  member: body(
                    { displayName: { type: 'string' }, acting: { type: 'boolean' } },
                    ['displayName'],
                  ),
                  // Present (true) only while the group is suspended (#20).
                  suspended: { type: 'boolean' },
                },
                ['group', 'branding', 'navPages'],
              ),
            ),
          },
        },
        async (request) => {
          const group = request.group!;
          const session = await sessionMemberContext(storage, request, group.id);
          const member = session?.member;
          const info: {
            group: { name: string; slug: string };
            branding: Awaited<ReturnType<typeof brandingFor>>;
            navPages: { slug: string; title: string }[];
            member?: { displayName: string; acting?: boolean };
            suspended?: boolean;
          } = {
            group: { name: group.name, slug: group.slug },
            branding: await brandingFor(storage, group.id),
            navPages: await navPagesFor(storage, group.id, member),
          };
          if (member !== undefined) {
            info.member = { displayName: member.displayName };
            // While acting (#24) displayName is already the target member's.
            if (session!.acting) info.member.acting = true;
          }
          // Omitted when active (#20): the flag drives the app's banner.
          if (group.status === 'suspended') info.suspended = true;
          return info;
        },
      );

      // Generic search (data-model Search interface): one public endpoint,
      // domain-scoped. The optional session sets the caller's tier — no
      // session searches the public face, a member adds the directory and
      // member pages, an admin sees admin pages too.
      scope.get(
        '/search',
        {
          schema: {
            querystring: {
              type: 'object',
              required: ['domain', 'q'],
              properties: {
                domain: { type: 'string', enum: SEARCH_DOMAIN },
                q: { type: 'string', minLength: 1 },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
                offset: { type: 'integer', minimum: 0 },
              },
            },
            response: respond(
              200,
              body({ items: arrayOf('SearchResult'), total: { type: 'integer' } }),
            ),
          },
        },
        async (request) => {
          const { domain, q, limit, offset } = request.query as {
            domain: SearchDomain;
            q: string;
            limit?: number;
            offset?: number;
          };
          const member = await sessionMember(storage, request, request.group!.id);
          const query: SearchQuery = {
            text: q,
            visibility:
              member === undefined ? 'public' : member.role === 'admin' ? 'admin' : 'member',
          };
          if (limit !== undefined) query.limit = limit;
          if (offset !== undefined) query.offset = offset;
          return storage.search(request.group!.id, domain, query);
        },
      );

      // account:read (decision #9): a token may see its member's own state.
      const accountRead: ApiScope[] = ['account:read'];
      scope.get(
        '/me',
        {
          preHandler: requireMember,
          config: { scopes: accountRead },
          schema: {
            response: respond(
              200,
              body(
                {
                  member: ref('Member'),
                  accounts: arrayOf('AccountBalance'),
                  // Present only while acting for a member (#24).
                  acting: body({ forMemberId: { type: 'string' } }),
                },
                ['member', 'accounts'],
              ),
            ),
          },
        },
        async (request) => {
        // photoId is derived, not a member column (#14 phase 2): copy before
        // annotating so the auth-cached member stays untouched.
        const member: Member = { ...request.auth!.member };
        const [photo] = await storage.listImages(request.group!.id, {
          ownerKind: 'member',
          ownerId: member.id,
        });
        if (photo !== undefined) member.photoId = photo.id;
        const currencies = new Map(
          (await storage.listCurrencies(request.group!.id)).map((currency) => [
            currency.id,
            currency,
          ]),
        );
        const accounts = [];
        const bandsByCurrency = new Map<string, DemurrageBand[]>();
        for (const account of await storage.accountsForMember(member.id)) {
          const currency = currencies.get(account.currencyId);
          const balance = await storage.balance(account.id);
          const entry: {
            id: string;
            currencyId: string;
            currencyCode: string;
            scale: number;
            balance: number;
            demurrage?: { amount: number; postingDate: string };
          } = {
            id: account.id,
            currencyId: account.currencyId,
            currencyCode: currency?.code ?? '',
            scale: currency?.scale ?? 0,
            balance,
          };
          // Projection (#1): what the next run would charge this balance,
          // computed with the run's own band engine.
          if (currency?.demurrageDay !== undefined) {
            let bands = bandsByCurrency.get(currency.id);
            if (bands === undefined) {
              bands = await storage.demurrageBands(currency.id);
              bandsByCurrency.set(currency.id, bands);
            }
            const amount = demurrageCharge(balance, bands);
            if (amount > 0) {
              entry.demurrage = {
                amount,
                postingDate: nextPostingDate(currency.demurrageDay, new Date()),
              };
            }
          }
          accounts.push(entry);
        }
        const result: {
          member: Member;
          accounts: typeof accounts;
          acting?: { forMemberId: string };
        } = { member, accounts };
        const actingFor = request.auth!.actingForMemberId;
        if (actingFor !== undefined) result.acting = { forMemberId: actingFor };
        return result;
      });

      scope.patch(
        '/me',
        {
          preHandler: requireMember,
          schema: {
            body: {
              type: 'object',
              properties: {
                confirmIncoming: { type: 'boolean' },
                displayName: { type: 'string' },
                digestFrequency: { type: 'string', enum: ['none', 'weekly', 'monthly'] },
              },
            },
            response: respond(200, body({ member: ref('Member') })),
          },
        },
        async (request) => {
          const body = request.body as {
            confirmIncoming?: boolean;
            displayName?: string;
            digestFrequency?: DigestFrequency;
          };
          const patch: Parameters<typeof storage.updateMember>[1] = {};
          if (body.confirmIncoming !== undefined) patch.confirmIncoming = body.confirmIncoming;
          if (body.displayName !== undefined) patch.displayName = body.displayName;
          if (body.digestFrequency !== undefined) patch.digestFrequency = body.digestFrequency;
          const member = await storage.updateMember(request.auth!.member.id, patch);
          return { member };
        },
      );

      scope.get(
        '/me/statement',
        {
          preHandler: requireMember,
          config: { scopes: accountRead },
          schema: {
            querystring: {
              type: 'object',
              required: ['currencyId'],
              properties: {
                currencyId: { type: 'string' },
                limit: { type: 'integer', minimum: 1 },
                offset: { type: 'integer', minimum: 0 },
              },
            },
            response: respond(
              200,
              body({ lines: arrayOf('StatementLine'), total: { type: 'integer' } }),
            ),
          },
        },
        async (request) => {
          const { currencyId, limit, offset } = request.query as {
            currencyId: string;
            limit?: number;
            offset?: number;
          };
          const accounts = await storage.accountsForMember(request.auth!.member.id);
          const account = accounts.find((candidate) => candidate.currencyId === currencyId);
          if (!account) return { lines: [], total: 0 };
          const page: { limit?: number; offset?: number } = {};
          if (limit !== undefined) page.limit = limit;
          if (offset !== undefined) page.offset = offset;
          return storage.statement(account.id, page);
        },
      );

      scope.get(
        '/me/statement.csv',
        {
          preHandler: requireMember,
          config: { scopes: accountRead },
          schema: {
            querystring: {
              type: 'object',
              required: ['currencyId'],
              properties: { currencyId: { type: 'string' } },
            },
            response: { 200: { type: 'string' }, '4XX': ERROR_REF },
          },
        },
        async (request, reply) => {
          const { currencyId } = request.query as { currencyId: string };
          const currency = (await storage.listCurrencies(request.group!.id)).find(
            (candidate) => candidate.id === currencyId,
          );
          if (!currency) {
            throw new DomainError('NOT_FOUND', `currency ${currencyId} not found in this group`);
          }
          const accounts = await storage.accountsForMember(request.auth!.member.id);
          const account = accounts.find((candidate) => candidate.currencyId === currencyId);
          const lines = account ? (await storage.statement(account.id)).lines : [];
          const rows = [CSV_HEADER];
          // Statement is newest first; the download reads oldest first.
          for (const line of [...lines].reverse()) {
            rows.push(
              [
                line.committedAt,
                line.type,
                line.description ?? '',
                line.reference ?? '',
                scaledAmount(line.amount, currency.scale),
                scaledAmount(line.runningBalance, currency.scale),
              ]
                .map(csvField)
                .join(','),
            );
          }
          return reply
            .type('text/csv; charset=utf-8')
            .header(
              'content-disposition',
              `attachment; filename="statement-${currency.code}.csv"`,
            )
            .send(rows.join('\n') + '\n');
        },
      );

      scope.get(
        '/me/pending',
        {
          preHandler: requireMember,
          config: { scopes: accountRead },
          schema: {
            response: respond(
              200,
              body({ pending: arrayOf('PendingItem'), items: arrayOf('PendingItem') }),
            ),
          },
        },
        async (request) => {
        const member = request.auth!.member;
        const pending: PendingItem[] = [];
        for (const tx of await storage.pendingForMember(member.id)) {
          let myAmount: number | undefined;
          for (const entry of tx.entries) {
            const account = await storage.getAccount(entry.accountId);
            if (account.memberId === member.id) {
              myAmount = entry.amount;
              break;
            }
          }
          if (myAmount === undefined) continue;
          const direction = myAmount > 0 ? 'in' : 'out';
          // #5 roles: the responder (payee of a held payment, payer of an
          // invoice) may accept/decline; the initiator may cancel.
          const responds =
            (tx.flow === 'payment' && direction === 'in') ||
            (tx.flow === 'invoice' && direction === 'out');
          const item: PendingItem = {
            id: tx.id,
            type: tx.type,
            amount: Math.abs(myAmount),
            direction,
            actions: responds ? ['accept', 'decline'] : ['cancel'],
          };
          if (tx.flow !== undefined) item.flow = tx.flow;
          if (tx.description !== undefined) item.description = tx.description;
          if (tx.expiresAt !== undefined) item.expiresAt = tx.expiresAt;
          pending.push(item);
        }
        // Served under both keys: 'pending' is the original shape; 'items'
        // is the name agent-facing clients use (decision #9 tests).
        return { pending, items: pending };
      });

      // Member profile photo (#14 phase 2): exactly one per member, raw
      // image body (the image/* content-type parser), replace-on-upload.
      // Member-scoped, not admin — each member manages their own photo.
      scope.post(
        '/me/photo',
        {
          preHandler: requireMember,
          // Raw-body route: a JSON body schema cannot describe a binary
          // upload, so only the response is declared (as /admin/images).
          schema: { response: respond(201, body({ image: ref('Image') })) },
        },
        async (request, reply) => {
          if (!Buffer.isBuffer(request.body)) {
            throw new DomainError('INVALID', 'the request body must be the raw image bytes');
          }
          const image = await setMemberPhoto(
            storage,
            request.auth!.member.id,
            request.headers['content-type'] ?? '',
            request.body,
          );
          reply.status(201);
          return { image };
        },
      );

      scope.delete(
        '/me/photo',
        {
          preHandler: requireMember,
          schema: { response: respond(200, OK_RESPONSE) },
        },
        async (request) => {
          await deleteMemberPhoto(storage, request.auth!.member.id);
          return { ok: true };
        },
      );

      // directory:read (decision #9): the public member directory.
      const directoryRead: ApiScope[] = ['directory:read'];
      scope.get(
        '/members',
        {
          preHandler: requireMember,
          config: { scopes: directoryRead },
          schema: {
            response: respond(
              200,
              body({ members: { type: 'array', items: PUBLIC_MEMBER_WITH_PHOTO } }),
            ),
          },
        },
        async (request) => {
          const members = await storage.listMembers(request.group!.id, 'active');
          // One query for the whole directory (#14 phase 2): every
          // member-owned image in the group, keyed by its owner.
          const photos = await storage.listImages(request.group!.id, { ownerKind: 'member' });
          const photoByMember = new Map(photos.map((image) => [image.ownerId, image.id]));
          return {
            members: members.map((member) => publicMember(member, photoByMember.get(member.id))),
          };
        },
      );

      scope.get(
        '/members/:id',
        {
          preHandler: requireMember,
          config: { scopes: directoryRead },
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(
              200,
              body({ member: PUBLIC_MEMBER_WITH_PHOTO, stats: ref('TradeStats') }),
            ),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const member = await storage.getMember(id);
          if (member.groupId !== request.group!.id) {
            throw new DomainError('NOT_FOUND', `member ${id} not found in this group`);
          }
          const [photo] = await storage.listImages(request.group!.id, {
            ownerKind: 'member',
            ownerId: id,
          });
          return { member: publicMember(member, photo?.id), stats: await storage.tradeStats(id) };
        },
      );

      // Group balances view (#19): every active member's balance and
      // 12-month trade income, published only when the group opts in via
      // settings.transparency — off means 404, a feature that doesn't exist.
      scope.get(
        '/balances',
        {
          preHandler: requireMember,
          config: { scopes: accountRead },
          schema: {
            querystring: {
              type: 'object',
              required: ['currencyId'],
              properties: { currencyId: { type: 'string' } },
            },
            response: respond(
              200,
              body({
                balances: {
                  type: 'array',
                  items: body({
                    memberId: { type: 'string' },
                    displayName: { type: 'string' },
                    balance: { type: 'integer' },
                    turnover: { type: 'integer' },
                  }),
                },
              }),
            ),
          },
        },
        async (request) => {
          if (effectiveSettings(request.group!).transparency !== 'balances') {
            throw new DomainError('NOT_FOUND', 'this group does not publish balances');
          }
          const { currencyId } = request.query as { currencyId: string };
          const since = new Date();
          since.setMonth(since.getMonth() - 12);
          const [members, balances, turnover] = await Promise.all([
            storage.listMembers(request.group!.id, 'active'),
            storage.memberBalances(request.group!.id, currencyId),
            storage.memberTurnover(request.group!.id, currencyId, since.toISOString()),
          ]);
          const balanceByMember = new Map(balances.map((row) => [row.memberId, row.balance]));
          const turnoverByMember = new Map(turnover.map((row) => [row.memberId, row.turnover]));
          return {
            balances: members
              .map((member) => ({
                memberId: member.id,
                displayName: member.displayName,
                balance: balanceByMember.get(member.id) ?? 0,
                turnover: turnoverByMember.get(member.id) ?? 0,
              }))
              .sort((a, b) => b.balance - a.balance),
          };
        },
      );

      scope.post(
        '/applications',
        {
          schema: {
            body: {
              type: 'object',
              required: ['displayName', 'personName', 'email', 'password'],
              properties: {
                displayName: { type: 'string' },
                personName: { type: 'string' },
                email: { type: 'string' },
                password: { type: 'string' },
              },
            },
            response: respond(201, body({ member: ref('Member') })),
          },
        },
        async (request, reply) => {
          const body = request.body as {
            displayName: string;
            personName: string;
            email: string;
            password: string;
          };
          const user = await register(storage, { email: body.email, password: body.password });
          const { member } = await apply(storage, {
            groupId: request.group!.id,
            displayName: body.displayName,
            personName: body.personName,
            email: body.email,
            userId: user.id,
          });
          // Lifecycle transition (§8): the freshly registered user applied.
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: user.id,
            action: 'member.apply', entityType: 'member', entityId: member.id,
          });
          // Verification email (data-model §1): best-effort — an email
          // hiccup must not fail the application itself.
          try {
            await sendEmailVerification(storage, {
              groupId: request.group!.id,
              userId: user.id,
              baseUrl: baseUrlFrom(request),
            });
          } catch (err) {
            request.log.error(err, 'failed to enqueue the verification email');
          }
          reply.status(201);
          return { member };
        },
      );

      // trade scopes (decision #9): either trade scope may reach the trade
      // routes; the handlers below decide commit vs pending per token.
      const tradeScopes: ApiScope[] = ['trade:request', 'trade:autonomous'];

      scope.post(
        '/payments',
        {
          preHandler: requireMember,
          config: { scopes: tradeScopes },
          schema: {
            body: {
              type: 'object',
              required: ['payeeMemberId', 'currencyId', 'amount'],
              properties: {
                payeeMemberId: { type: 'string' },
                currencyId: { type: 'string' },
                amount: { type: 'integer' },
                description: { type: 'string' },
              },
            },
            response: respond(201, body({ transaction: ref('Transaction') })),
          },
        },
        async (request, reply) => {
          const body = request.body as {
            payeeMemberId: string;
            currencyId: string;
            amount: number;
            description?: string;
          };
          const token = request.auth!.token;
          if (token !== undefined && !token.scopes.includes('trade:autonomous')) {
            // trade:request (decision #9): the agent proposes, the member
            // disposes. The payment is posted as a pending item via
            // requestPayment — #5's invoice-flow machinery — with the token's
            // member as payer, so the member (the payer = the invoice-flow
            // responder) confirms it with accept in the web UI. No balance
            // moves until then.
            const input: Parameters<typeof requestPayment>[1] = {
              groupId: request.group!.id,
              payerMemberId: request.auth!.member.id,
              payeeMemberId: body.payeeMemberId,
              currencyId: body.currencyId,
              amount: body.amount,
              actorPersonId: token.createdBy,
              channel: 'mcp',
              apiTokenId: token.id,
            };
            if (body.description !== undefined) input.description = body.description;
            const transaction = await requestPayment(storage, input);
            reply.status(201);
            return { transaction };
          }
          const input: Parameters<typeof sendPayment>[1] = {
            groupId: request.group!.id,
            payerMemberId: request.auth!.member.id,
            payeeMemberId: body.payeeMemberId,
            currencyId: body.currencyId,
            amount: body.amount,
            actorPersonId: request.auth!.user.id,
            channel: 'web',
          };
          if (token !== undefined) {
            // trade:autonomous (decision #9): commits directly, but only
            // within the member-granted per-transaction and rolling caps.
            await checkTokenCaps(storage, token, body.amount, new Date().toISOString());
            input.actorPersonId = token.createdBy;
            input.channel = 'mcp';
            input.apiTokenId = token.id;
          }
          if (body.description !== undefined) input.description = body.description;
          const transaction = await sendPayment(storage, input);
          reply.status(201);
          return { transaction };
        },
      );

      scope.post(
        '/invoices',
        {
          preHandler: requireMember,
          config: { scopes: tradeScopes },
          schema: {
            body: {
              type: 'object',
              required: ['payerMemberId', 'currencyId', 'amount'],
              properties: {
                payerMemberId: { type: 'string' },
                currencyId: { type: 'string' },
                amount: { type: 'integer' },
                description: { type: 'string' },
              },
            },
            response: respond(201, body({ transaction: ref('Transaction') })),
          },
        },
        async (request, reply) => {
          const body = request.body as {
            payerMemberId: string;
            currencyId: string;
            amount: number;
            description?: string;
          };
          // Same shape for both channels: the payee is the acting member —
          // for a token, the token's member (decision #9). Invoices are
          // always pending, so no cap check: the payer commits, not the token.
          const token = request.auth!.token;
          const input: Parameters<typeof requestPayment>[1] = {
            groupId: request.group!.id,
            payeeMemberId: request.auth!.member.id,
            payerMemberId: body.payerMemberId,
            currencyId: body.currencyId,
            amount: body.amount,
            actorPersonId: token === undefined ? request.auth!.user.id : token.createdBy,
            channel: token === undefined ? 'web' : 'mcp',
          };
          if (token !== undefined) input.apiTokenId = token.id;
          if (body.description !== undefined) input.description = body.description;
          const transaction = await requestPayment(storage, input);
          reply.status(201);
          return { transaction };
        },
      );

      // Signed QR payment requests (#22): mint (payee), decode (payer's
      // confirm screen), scan (pay). Cookie-only — no scopes config, so
      // API tokens are rejected by requireTokenMember.
      scope.post(
        '/me/payment-requests',
        {
          preHandler: requireMember,
          schema: {
            body: {
              type: 'object',
              required: ['currencyId'],
              properties: {
                currencyId: { type: 'string' },
                amount: { type: 'integer' },
                reference: { type: 'string' },
                expiresAt: { type: 'string' },
              },
            },
            response: respond(201, body({ payload: { type: 'string' } })),
          },
        },
        async (request, reply) => {
          const input = request.body as {
            currencyId: string;
            amount?: number;
            reference?: string;
            expiresAt?: string;
          };
          const minted = await mintPaymentRequest(storage, request.auth!.member.id, input);
          reply.status(201);
          return minted;
        },
      );

      scope.get(
        '/payment-requests/decode',
        {
          preHandler: requireMember,
          schema: {
            querystring: {
              type: 'object',
              required: ['payload'],
              properties: { payload: { type: 'string' } },
            },
            // The serializer strips the nonce: it is the idempotency handle,
            // not confirm-screen data (#22).
            response: respond(
              200,
              body(
                {
                  payeeMemberId: { type: 'string' },
                  payeeName: { type: 'string' },
                  currencyId: { type: 'string' },
                  amount: { type: 'integer' },
                  reference: { type: 'string' },
                  expiresAt: { type: 'string' },
                },
                ['payeeMemberId', 'payeeName', 'currencyId'],
              ),
            ),
          },
        },
        async (request) => {
          const { payload } = request.query as { payload: string };
          return decodePaymentRequest(storage, request.group!.id, payload);
        },
      );

      scope.post(
        '/payments/scan',
        {
          preHandler: requireMember,
          schema: {
            body: {
              type: 'object',
              required: ['payload'],
              properties: {
                payload: { type: 'string' },
                amount: { type: 'integer' },
              },
            },
            response: respond(201, body({ transaction: ref('Transaction') })),
          },
        },
        async (request, reply) => {
          const { payload, amount } = request.body as { payload: string; amount?: number };
          const transaction = await scanPayment(
            storage,
            request.auth!.member.id,
            payload,
            amount,
          );
          reply.status(201);
          return { transaction };
        },
      );

      const transitions = { accept, decline, cancel } as const;
      for (const [action, service] of Object.entries(transitions)) {
        scope.post(
          `/transactions/:id/${action}`,
          {
            preHandler: requireMember,
            schema: {
              params: ID_PARAM_SCHEMA,
              response: respond(200, body({ transaction: ref('Transaction') })),
            },
          },
          async (request) => {
            const { id } = request.params as { id: string };
            const transaction = await service(storage, id, request.auth!.member.id);
            return { transaction };
          },
        );
      }

      scope.get(
        '/listings',
        {
          schema: {
            querystring: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['offer', 'want'] },
                categoryId: { type: 'string' },
              },
            },
            response: respond(200, body({ listings: arrayOf('Listing') })),
          },
        },
        async (request) => {
          const query = request.query as { type?: ListingType; categoryId?: string };
          const filter: { type?: ListingType; categoryId?: string } = {};
          if (query.type !== undefined) filter.type = query.type;
          if (query.categoryId !== undefined) filter.categoryId = query.categoryId;
          const listings = await browse(storage, request.group!.id, filter);
          // photoIds are derived, not listing columns (#14 phase 3): one
          // group-wide query, grouped by listing, in upload order.
          const photos = await listingPhotoIds(storage, request.group!.id);
          return {
            listings: listings.map((listing) => ({
              ...listing,
              photoIds: photos.get(listing.id) ?? [],
            })),
          };
        },
      );

      scope.post(
        '/listings',
        {
          preHandler: requireMember,
          config: { scopes: ['listings:write'] satisfies ApiScope[] },
          schema: {
            body: {
              type: 'object',
              required: ['type', 'title', 'description', 'categoryId'],
              properties: {
                type: { type: 'string', enum: ['offer', 'want'] },
                title: { type: 'string' },
                description: { type: 'string' },
                categoryId: { type: 'string' },
                priceAmount: { type: 'integer' },
                priceCurrencyId: { type: 'string' },
                rateText: { type: 'string' },
                expiresAt: { type: 'string' },
              },
            },
            response: respond(201, body({ listing: ref('Listing') })),
          },
        },
        async (request, reply) => {
          const body = request.body as {
            type: ListingType;
            title: string;
            description: string;
            categoryId: string;
            priceAmount?: number;
            priceCurrencyId?: string;
            rateText?: string;
            expiresAt?: string;
          };
          const input: Parameters<typeof postListing>[2] = {
            type: body.type,
            title: body.title,
            description: body.description,
            categoryId: body.categoryId,
          };
          if (body.priceAmount !== undefined) input.priceAmount = body.priceAmount;
          if (body.priceCurrencyId !== undefined) input.priceCurrencyId = body.priceCurrencyId;
          if (body.rateText !== undefined) input.rateText = body.rateText;
          if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt;
          const listing = await postListing(storage, request.auth!.member.id, input);
          reply.status(201);
          return { listing };
        },
      );

      // --- Listing photos (#14 phase 3): the owner attaches up to five raw
      // image bodies (1MB each); photoIds ride on listing responses above
      // and the bytes are served by GET /i/{id} in brochure.ts.

      /** Assert the listing exists in the request's group (tenancy isolation). */
      async function targetListing(request: FastifyRequest, id: string): Promise<void> {
        const listing = await storage.getListing(id);
        if (listing.groupId !== request.group!.id) {
          throw new DomainError('NOT_FOUND', `listing ${id} not found in this group`);
        }
      }

      scope.post(
        '/listings/:id/photos',
        {
          preHandler: requireMember,
          // Raw-body route: a JSON body schema cannot describe a binary
          // upload, so only the response is declared (as /me/photo).
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(201, body({ image: ref('Image') })),
          },
        },
        async (request, reply) => {
          if (!Buffer.isBuffer(request.body)) {
            throw new DomainError('INVALID', 'the request body must be the raw image bytes');
          }
          const { id } = request.params as { id: string };
          await targetListing(request, id);
          const image = await addListingPhoto(
            storage,
            id,
            request.auth!.member.id,
            request.headers['content-type'] ?? '',
            request.body,
          );
          reply.status(201);
          return { image };
        },
      );

      const LISTING_PHOTO_PARAM_SCHEMA = {
        type: 'object',
        required: ['id', 'imageId'],
        properties: { id: { type: 'string' }, imageId: { type: 'string' } },
      } as const;
      scope.delete(
        '/listings/:id/photos/:imageId',
        {
          preHandler: requireMember,
          schema: {
            params: LISTING_PHOTO_PARAM_SCHEMA,
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { id, imageId } = request.params as { id: string; imageId: string };
          await targetListing(request, id);
          await removeListingPhoto(storage, id, imageId, request.auth!.member.id);
          return { ok: true };
        },
      );

      // Renew (#18): the owner resets the shelf life with one POST — a human
      // act like accept, so cookie sessions only (no token scope).
      scope.post(
        '/listings/:id/renew',
        {
          preHandler: requireMember,
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(200, body({ listing: ref('Listing') })),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          await targetListing(request, id);
          const listing = await renewListing(storage, id, request.auth!.member.id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'listing.renew', entityType: 'listing', entityId: id,
          });
          return { listing };
        },
      );

      scope.get(
        '/categories',
        { schema: { response: respond(200, body({ categories: arrayOf('Category') })) } },
        async (request) => {
          return { categories: await storage.listCategories(request.group!.id) };
        },
      );

      scope.get(
        '/currencies',
        { schema: { response: respond(200, body({ currencies: arrayOf('Currency') })) } },
        async (request) => {
          return { currencies: await storage.listCurrencies(request.group!.id) };
        },
      );

      // --- MCP endpoint (decision #9) ---------------------------------------
      // A Streamable HTTP MCP server at {tenancy}/mcp whose tools are a thin
      // client of this same REST API: each tool call is re-injected into the
      // root Fastify app with the caller's Authorization header, so REST
      // scope checks, trade caps, and audit logging apply unchanged — the
      // MCP layer adds no authority of its own. Stateless per the SDK's
      // documented pattern: a fresh server + transport per request, no
      // session ids, plain JSON responses (no SSE).
      const mcpHandler = async (
        request: FastifyRequest,
        reply: FastifyReply,
      ): Promise<unknown> => {
        // Bearer-only auth, done here rather than via requireMember: the MCP
        // handshake itself needs no scope, and tokens are the only principal.
        // Deliberately uncounted by the per-token rate limit — every tool
        // call re-injects with this bearer header and is counted where it
        // lands, in requireTokenMember; counting here would double-charge.
        const authorization = request.headers.authorization;
        if (authorization === undefined || !authorization.startsWith('Bearer ')) {
          return reply
            .status(401)
            .send(errorBody('NOT_AUTHORISED', 'a valid API token is required'));
        }
        const result = await authenticateApiToken(
          storage,
          authorization.slice('Bearer '.length),
        );
        if (!result) {
          return reply
            .status(401)
            .send(errorBody('NOT_AUTHORISED', 'a valid API token is required'));
        }
        if (result.member.groupId !== request.group!.id) {
          return reply
            .status(403)
            .send(errorBody('NOT_AUTHORISED', 'this token belongs to another group'));
        }
        // Tenancy base path: the request URL minus '/mcp' and any query, so
        // /api/v1/g/cam/mcp forwards tools to /api/v1/g/cam/... . The host
        // header rides along for host-based tenancy resolution.
        const path = request.url.split('?')[0] ?? request.url;
        const base = path.slice(0, path.length - '/mcp'.length);
        const host = request.headers.host;
        const rest: RestClient = {
          call: async (method, restPath, payload) => {
            const res = await app.inject({
              method,
              url: `${base}${restPath}`,
              headers: { authorization, ...(host === undefined ? {} : { host }) },
              ...(payload === undefined ? {} : { payload: payload as object }),
            });
            return { statusCode: res.statusCode, body: res.body };
          },
        };
        const server = buildMcpServer({ scopes: result.token.scopes, rest });
        // The assertions below paper over the SDK's d.ts not being written
        // for exactOptionalPropertyTypes; they change nothing at runtime.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: no session ids
          enableJsonResponse: true,
        } as unknown as StreamableHTTPServerTransportOptions);
        reply.raw.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport as Transport);
        // Hand the raw response to the transport; Fastify has already parsed
        // the JSON body, so pass it through as the pre-read body.
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
        return reply;
      };
      // POST carries the JSON-RPC traffic; the stateless transport answers
      // GET (SSE) and DELETE (session teardown) with 405 itself. Hidden from
      // the OpenAPI document — it is not a REST route.
      scope.post('/mcp', { schema: { hide: true } }, mcpHandler);
      scope.get('/mcp', { schema: { hide: true } }, mcpHandler);
      scope.delete('/mcp', { schema: { hide: true } }, mcpHandler);

      // --- Joint members: the persons surface (#23) -------------------------
      // Any person on a membership manages its people; adds and removes are
      // audited — they grant and revoke account access.

      scope.get(
        '/me/persons',
        {
          preHandler: requireMember,
          schema: { response: respond(200, body({ persons: arrayOf('Person') })) },
        },
        async (request) => {
          return { persons: await storage.personsForMember(request.auth!.member.id) };
        },
      );

      scope.post(
        '/me/persons',
        {
          preHandler: [requireMember, refuseWhileActing],
          schema: {
            body: {
              type: 'object',
              required: ['name', 'email'],
              properties: {
                name: { type: 'string' },
                email: { type: 'string' },
              },
            },
            response: respond(201, body({ person: ref('Person') })),
          },
        },
        async (request, reply) => {
          const payload = request.body as { name: string; email: string };
          const { person } = await addPerson(
            storage,
            request.auth!.member.id,
            payload,
            baseUrlFrom(request),
          );
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'person.add', entityType: 'person', entityId: person.id,
            detail: { name: payload.name },
          });
          reply.status(201);
          return { person };
        },
      );

      scope.delete(
        '/me/persons/:id',
        {
          preHandler: [requireMember, refuseWhileActing],
          schema: { params: ID_PARAM_SCHEMA, response: respond(200, OK_RESPONSE) },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const person = await removePerson(storage, request.auth!.member.id, id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'person.remove', entityType: 'person', entityId: id,
            detail: { name: person.name },
          });
          return { ok: true };
        },
      );

      // --- API token management (decision #9) -------------------------------
      // Cookie-only by design (no scopes config): a token must never mint,
      // list, or revoke tokens. The raw value appears exactly once, in the
      // creation response; listings expose ApiToken records, never the hash.

      scope.post(
        '/me/tokens',
        {
          preHandler: [requireMember, refuseWhileActing],
          schema: {
            body: {
              type: 'object',
              required: ['label', 'scopes'],
              properties: {
                label: { type: 'string' },
                scopes: { type: 'array', items: { type: 'string' } },
                maxTxAmount: { type: 'integer' },
                maxPeriodAmount: { type: 'integer' },
                periodDays: { type: 'integer' },
                expiresAt: { type: 'string' },
              },
            },
            response: respond(
              201,
              body({ token: { type: 'string' }, apiToken: ref('ApiToken') }),
            ),
          },
        },
        async (request, reply) => {
          const body = request.body as {
            label: string;
            scopes: ApiScope[];
            maxTxAmount?: number;
            maxPeriodAmount?: number;
            periodDays?: number;
            expiresAt?: string;
          };
          const member = request.auth!.member;
          // createdBy is the session user's person within this membership
          // (joint members share one member, so attribution matters).
          const persons = await storage.personsForMember(member.id);
          const person = persons.find(
            (candidate) => candidate.userId === request.auth!.user.id,
          );
          const input: Parameters<typeof issueApiToken>[1] = {
            memberId: member.id,
            createdBy: person?.id ?? request.auth!.user.id,
            label: body.label,
            scopes: body.scopes,
          };
          if (body.maxTxAmount !== undefined) input.maxTxAmount = body.maxTxAmount;
          if (body.maxPeriodAmount !== undefined) input.maxPeriodAmount = body.maxPeriodAmount;
          if (body.periodDays !== undefined) input.periodDays = body.periodDays;
          if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt;
          const { token, apiToken } = await issueApiToken(storage, input);
          // §8 calls out MCP grants explicitly: token issue/revoke is audited.
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'token.issue', entityType: 'api_token', entityId: apiToken.id,
            detail: { label: body.label, scopes: body.scopes },
          });
          reply.status(201);
          return { token, apiToken };
        },
      );

      scope.get(
        '/me/tokens',
        {
          preHandler: requireMember,
          schema: { response: respond(200, body({ tokens: arrayOf('ApiToken') })) },
        },
        async (request) => {
          return { tokens: await storage.listApiTokens(request.auth!.member.id) };
        },
      );

      scope.delete(
        '/me/tokens/:id',
        {
          preHandler: [requireMember, refuseWhileActing],
          schema: { params: ID_PARAM_SCHEMA, response: respond(200, OK_RESPONSE) },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          // Ownership check doubles as existence check: 404 either way, so
          // token ids leak nothing across members.
          const owned = await storage.listApiTokens(request.auth!.member.id);
          if (!owned.some((candidate) => candidate.id === id)) {
            throw new DomainError('NOT_FOUND', `token ${id} not found`);
          }
          await storage.revokeApiToken(id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'token.revoke', entityType: 'api_token', entityId: id,
          });
          return { ok: true };
        },
      );

      // --- Admin area: role-gated group management (decision #2) -----------

      /** Assert the member exists in the request's group (tenancy isolation). */
      async function targetMember(request: FastifyRequest, id: string): Promise<Member> {
        const target = await storage.getMember(id);
        if (target.groupId !== request.group!.id) {
          throw new DomainError('NOT_FOUND', `member ${id} not found in this group`);
        }
        return target;
      }

      scope.get(
        '/admin/members',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            querystring: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: ['applied', 'active', 'away', 'suspended', 'closed'],
                },
              },
            },
            response: respond(200, body({ members: arrayOf('Member') })),
          },
        },
        async (request) => {
          const { status } = request.query as { status?: MemberStatus };
          return { members: await storage.listMembers(request.group!.id, status) };
        },
      );

      // Lifecycle actions (decision #7): suspend/reinstate, and remove
      // settling any residual balance to the community account.
      const memberActions = { approve, suspend, reinstate, remove: leave } as const;
      for (const [action, service] of Object.entries(memberActions)) {
        scope.post(
          `/admin/members/:id/${action}`,
          {
            preHandler: [requireMember, requireAdmin],
            schema: {
              params: ID_PARAM_SCHEMA,
              response: respond(200, body({ member: ref('Member') })),
            },
          },
          async (request) => {
            const { id } = request.params as { id: string };
            await targetMember(request, id);
            const member = await service(storage, id);
            // §8: audited under the route's name — member.remove, not .leave.
            await recordAudit(storage, {
              groupId: request.group!.id, actorUserId: request.auth!.user.id,
              action: `member.${action}`, entityType: 'member', entityId: id,
            });
            return { member };
          },
        );
      }

      // Role changes (first-admin bootstrap follow-on): admins set roles, but
      // never their own — a group must not lose its last admin by accident.
      scope.post(
        '/admin/members/:id/role',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            body: {
              type: 'object',
              required: ['role'],
              properties: {
                role: { type: 'string', enum: ['member', 'committee', 'admin'] },
              },
            },
            response: respond(200, body({ member: ref('Member') })),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const { role } = request.body as { role: MemberRole };
          await targetMember(request, id);
          if (id === request.auth!.member.id) {
            throw new DomainError('INVALID', 'cannot change your own role');
          }
          const member = await storage.updateMember(id, { role });
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'member.role', entityType: 'member', entityId: id, detail: { role },
          });
          return { member };
        },
      );

      // Acts-for-member (#24): stamp the acting context on the admin's own
      // session — the app then presents as the member, auth.user stays the
      // admin, and both ends are audited with acting_for_member_id.
      scope.post(
        '/admin/members/:id/act-as',
        {
          preHandler: [requireMember, requireAdmin],
          schema: { params: ID_PARAM_SCHEMA, response: respond(200, OK_RESPONSE) },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          await targetMember(request, id);
          await storage.setSessionActing(request.auth!.session!.id, id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            actingForMemberId: id,
            action: 'member.act_as', entityType: 'member', entityId: id,
          });
          return { ok: true };
        },
      );

      // The reverse of act-as; works while acting, no-op when not.
      scope.post(
        '/me/stop-acting',
        {
          preHandler: requireMember,
          schema: { response: respond(200, OK_RESPONSE) },
        },
        async (request) => {
          const actingFor = request.auth!.actingForMemberId;
          if (actingFor === undefined) return { ok: true };
          await storage.setSessionActing(request.auth!.session!.id, null);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            actingForMemberId: actingFor,
            action: 'member.stop_acting', entityType: 'member', entityId: actingFor,
          });
          return { ok: true };
        },
      );

      // Admin broadcast (#17): subject/body verbatim (body is markdown;
      // delivery renders the HTML part), one email per person-with-email on
      // every active membership. Each call is a new event — the dedup key
      // carries a fresh broadcast id — and 'broadcast' is deliberately not an
      // email template kind.
      scope.post(
        '/admin/broadcast',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              required: ['subject', 'body'],
              properties: {
                subject: { type: 'string' },
                body: { type: 'string' },
              },
            },
            response: respond(
              200,
              body({ ok: { type: 'boolean' }, queued: { type: 'integer' } }),
            ),
          },
        },
        async (request) => {
          const { subject, body } = request.body as { subject: string; body: string };
          const group = request.group!;
          const broadcastId = randomUUID();
          const nowIso = new Date().toISOString();
          let queued = 0;
          for (const member of await storage.listMembers(group.id, 'active')) {
            for (const person of await storage.personsForMember(member.id)) {
              if (person.email === undefined) continue;
              const event = await storage.enqueueEmail({
                groupId: group.id,
                personId: person.id,
                kind: 'broadcast',
                dedupKey: `broadcast:${broadcastId}:${person.id}`,
                toEmail: person.email,
                subject,
                body,
                // Snapshot the group sender (#16); absent falls back at delivery.
                ...(group.emailFrom !== undefined ? { fromEmail: group.emailFrom } : {}),
                createdAt: nowIso,
              });
              if (event !== undefined) queued += 1;
            }
          }
          await recordAudit(storage, {
            groupId: group.id, actorUserId: request.auth!.user.id,
            action: 'broadcast.send', entityType: 'broadcast', entityId: broadcastId,
            detail: { subject, queued },
          });
          return { ok: true, queued };
        },
      );

      scope.get(
        '/admin/policies',
        {
          preHandler: [requireMember, requireAdmin],
          schema: { response: respond(200, body({ policies: arrayOf('CreditPolicy') })) },
        },
        async (request) => {
          return { policies: await storage.listCreditPolicies(request.group!.id) };
        },
      );

      scope.post(
        '/admin/policies',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              required: ['currencyId', 'type', 'config'],
              properties: {
                currencyId: { type: 'string' },
                type: { type: 'string', enum: ['soft_threshold', 'hard_limit'] },
                config: { type: 'object' },
              },
            },
            response: respond(201, body({ policy: ref('CreditPolicy') })),
          },
        },
        async (request, reply) => {
          const body = request.body as {
            currencyId: string;
            type: CreditPolicyType;
            config: CreditPolicyConfig;
          };
          const policy = await storage.setCreditPolicy({
            groupId: request.group!.id,
            currencyId: body.currencyId,
            type: body.type,
            config: body.config,
          });
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'policy.create', entityType: 'credit_policy', entityId: policy.id,
          });
          reply.status(201);
          return { policy };
        },
      );

      scope.patch(
        '/admin/policies/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            body: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                config: { type: 'object' },
              },
            },
            response: respond(200, body({ policy: ref('CreditPolicy') })),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const body = request.body as { enabled?: boolean; config?: CreditPolicyConfig };
          const patch: Parameters<typeof storage.updateCreditPolicy>[1] = {};
          if (body.enabled !== undefined) patch.enabled = body.enabled;
          if (body.config !== undefined) patch.config = body.config;
          const policy = await storage.updateCreditPolicy(id, patch);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'policy.update', entityType: 'credit_policy', entityId: id,
          });
          return { policy };
        },
      );

      const CURRENCY_PARAM_SCHEMA = {
        type: 'object',
        required: ['currencyId'],
        properties: { currencyId: { type: 'string' } },
      } as const;

      scope.get(
        '/admin/demurrage/:currencyId/bands',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: CURRENCY_PARAM_SCHEMA,
            response: respond(200, body({ bands: arrayOf('DemurrageBand') })),
          },
        },
        async (request) => {
          const { currencyId } = request.params as { currencyId: string };
          return { bands: await storage.demurrageBands(currencyId) };
        },
      );

      scope.put(
        '/admin/demurrage/:currencyId/bands',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: CURRENCY_PARAM_SCHEMA,
            body: {
              type: 'object',
              required: ['bands'],
              properties: {
                bands: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['fromAmount', 'ratePpmPerMonth'],
                    properties: {
                      fromAmount: { type: 'integer' },
                      ratePpmPerMonth: { type: 'integer' },
                    },
                  },
                },
              },
            },
            response: respond(200, body({ bands: arrayOf('DemurrageBand') })),
          },
        },
        async (request) => {
          const { currencyId } = request.params as { currencyId: string };
          const body = request.body as { bands: DemurrageBand[] };
          await storage.setDemurrageBands(currencyId, body.bands);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'demurrage.bands', entityType: 'currency', entityId: currencyId,
          });
          return { bands: await storage.demurrageBands(currencyId) };
        },
      );

      // Run history (todo: Admin & governance): when each posting ran and
      // completed, newest first.
      scope.get(
        '/admin/runs',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            response: respond(200, body({ runs: arrayOf('DemurrageRun') })),
          },
        },
        async (request) => {
          return { runs: await storage.listDemurrageRuns(request.group!.id) };
        },
      );

      scope.get(
        '/admin/restrictions',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            response: respond(200, body({ restrictions: arrayOf('Restriction') })),
          },
        },
        async (request) => {
          return { restrictions: await storage.activeRestrictions(request.group!.id) };
        },
      );

      scope.post(
        '/admin/restrictions',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              required: ['memberId', 'reason'],
              properties: {
                memberId: { type: 'string' },
                reason: { type: 'string' },
              },
            },
            response: respond(201, body({ restriction: ref('Restriction') })),
          },
        },
        async (request, reply) => {
          const body = request.body as { memberId: string; reason: string };
          await targetMember(request, body.memberId);
          const restriction = await storage.imposeRestriction(
            body.memberId,
            body.reason,
            request.auth!.member.id,
          );
          await notifyRestrictionImposed(storage, restriction);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'restriction.impose', entityType: 'member', entityId: body.memberId,
            detail: { reason: body.reason },
          });
          reply.status(201);
          return { restriction };
        },
      );

      scope.delete(
        '/admin/restrictions/:memberId',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: {
              type: 'object',
              required: ['memberId'],
              properties: { memberId: { type: 'string' } },
            },
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { memberId } = request.params as { memberId: string };
          await storage.liftRestriction(memberId, request.auth!.member.id);
          await notifyRestrictionLifted(storage, memberId);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'restriction.lift', entityType: 'member', entityId: memberId,
          });
          return { ok: true };
        },
      );

      scope.get(
        '/admin/flags',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            querystring: {
              type: 'object',
              required: ['currencyId'],
              properties: { currencyId: { type: 'string' } },
            },
            response: respond(200, body({ flags: arrayOf('AccountFlag') })),
          },
        },
        async (request) => {
          const { currencyId } = request.query as { currencyId: string };
          return { flags: await evaluateFlags(storage, request.group!.id, currencyId) };
        },
      );

      scope.get(
        '/admin/transactions',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            querystring: {
              type: 'object',
              properties: {
                memberId: { type: 'string' },
                currencyId: { type: 'string' },
                type: {
                  type: 'string',
                  enum: ['trade', 'demurrage', 'fee', 'settlement', 'reversal', 'adjustment'],
                },
                state: {
                  type: 'string',
                  enum: ['pending', 'committed', 'declined', 'cancelled', 'expired'],
                },
                q: { type: 'string' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
              },
            },
            response: respond(
              200,
              body({ transactions: arrayOf('Transaction'), total: { type: 'integer' } }),
            ),
          },
        },
        async (request) => {
          const query = request.query as {
            memberId?: string;
            currencyId?: string;
            type?: TransactionFilter['type'];
            state?: TransactionFilter['state'];
            q?: string;
            limit?: number;
            offset?: number;
          };
          const filter: TransactionFilter = {};
          if (query.memberId !== undefined) filter.memberId = query.memberId;
          if (query.currencyId !== undefined) filter.currencyId = query.currencyId;
          if (query.type !== undefined) filter.type = query.type;
          if (query.state !== undefined) filter.state = query.state;
          if (query.q !== undefined) filter.text = query.q;
          if (query.limit !== undefined) filter.limit = query.limit;
          if (query.offset !== undefined) filter.offset = query.offset;
          return storage.listTransactions(request.group!.id, filter);
        },
      );

      scope.post(
        '/admin/transactions/:id/reverse',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(201, body({ transaction: ref('Transaction') })),
          },
        },
        async (request, reply) => {
          const { id } = request.params as { id: string };
          const original = await storage.getTransaction(id);
          if (original.groupId !== request.group!.id) {
            throw new DomainError('NOT_FOUND', `transaction ${id} not found in this group`);
          }
          const transaction = await reverse(storage, id, request.auth!.user.id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'transaction.reverse', entityType: 'transaction', entityId: id,
          });
          reply.status(201);
          return { transaction };
        },
      );

      // Dashboard stats (plan.md): balance distribution, monthly trade flow,
      // velocity and dormancy for one currency; the UI draws the graphs.
      scope.get(
        '/admin/stats',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            querystring: {
              type: 'object',
              required: ['currencyId'],
              properties: { currencyId: { type: 'string' } },
            },
            response: respond(200, body({
              balances: {
                type: 'array',
                items: body({
                  memberId: { type: 'string' },
                  displayName: { type: 'string' },
                  balance: { type: 'integer' },
                }),
              },
              flow: {
                type: 'array',
                items: body({
                  month: { type: 'string' },
                  volume: { type: 'integer' },
                  trades: { type: 'integer' },
                }),
              },
              velocity: { type: 'number' },
              dormant: {
                type: 'array',
                items: body({
                  memberId: { type: 'string' },
                  displayName: { type: 'string' },
                  lastTradeAt: { type: 'string' },
                }, ['memberId', 'displayName']),
              },
            })),
          },
        },
        async (request) => {
          const { currencyId } = request.query as { currencyId: string };
          return dashboardStats(
            storage, request.group!.id, currencyId, new Date().toISOString(),
          );
        },
      );

      // Audit trail (data-model §8): the append-only admin/lifecycle log,
      // newest first, filterable by action/entity.
      scope.get(
        '/admin/audit',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            querystring: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                entityType: { type: 'string' },
                entityId: { type: 'string' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
              },
            },
            response: respond(
              200,
              body({ events: arrayOf('AuditEvent'), total: { type: 'integer' } }),
            ),
          },
        },
        async (request) => {
          const query = request.query as {
            action?: string;
            entityType?: string;
            entityId?: string;
            limit?: number;
            offset?: number;
          };
          const filter: AuditEventFilter = { limit: query.limit ?? 50 };
          if (query.action !== undefined) filter.action = query.action;
          if (query.entityType !== undefined) filter.entityType = query.entityType;
          if (query.entityId !== undefined) filter.entityId = query.entityId;
          if (query.offset !== undefined) filter.offset = query.offset;
          return storage.listAuditEvents(request.group!.id, filter);
        },
      );

      /** Assert the category exists in the request's group (tenancy isolation). */
      async function targetCategory(request: FastifyRequest, id: string): Promise<Category> {
        const category = await storage.getCategory(id);
        if (category.groupId !== request.group!.id) {
          throw new DomainError('NOT_FOUND', `category ${id} not found in this group`);
        }
        return category;
      }

      scope.post(
        '/admin/categories',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                parentId: { type: 'string' },
              },
            },
            response: respond(201, body({ category: ref('Category') })),
          },
        },
        async (request, reply) => {
          const body = request.body as { name: string; parentId?: string };
          const input: Parameters<typeof storage.createCategory>[0] = {
            groupId: request.group!.id,
            name: body.name,
          };
          if (body.parentId !== undefined) {
            await targetCategory(request, body.parentId);
            input.parentId = body.parentId;
          }
          const category = await storage.createCategory(input);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'category.create', entityType: 'category', entityId: category.id,
          });
          reply.status(201);
          return { category };
        },
      );

      scope.patch(
        '/admin/categories/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            body: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                parentId: { type: 'string' },
              },
            },
            response: respond(200, body({ category: ref('Category') })),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const body = request.body as { name?: string; parentId?: string };
          await targetCategory(request, id);
          const patch: Parameters<typeof storage.updateCategory>[1] = {};
          if (body.name !== undefined) patch.name = body.name;
          if (body.parentId !== undefined) patch.parentId = body.parentId;
          const category = await storage.updateCategory(id, patch);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'category.update', entityType: 'category', entityId: id,
          });
          return { category };
        },
      );

      scope.delete(
        '/admin/categories/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            querystring: {
              type: 'object',
              properties: { moveTo: { type: 'string' } },
            },
            response: respond(
              200,
              body({ ok: { type: 'boolean' }, moved: { type: 'integer' } }),
            ),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const { moveTo } = request.query as { moveTo?: string };
          const category = await targetCategory(request, id);
          if (await storage.categoryHasChildren(id)) {
            throw new DomainError('LIMIT_BREACHED', 'delete or move its subcategories first');
          }
          if (moveTo === id) {
            throw new DomainError('INVALID', 'moveTo must be a different category');
          }
          if (moveTo !== undefined) await targetCategory(request, moveTo);
          let moved = 0;
          if (await storage.categoryHasListings(id)) {
            if (moveTo === undefined) {
              throw new DomainError(
                'LIMIT_BREACHED',
                'this category has listings; pass moveTo to recategorise them',
              );
            }
            moved = await storage.recategoriseListings(id, moveTo);
          }
          await storage.deleteCategory(id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'category.delete', entityType: 'category', entityId: id,
            detail: { name: category.name, moved },
          });
          return { ok: true, moved };
        },
      );

      // --- CMS pages (decision #13): admin-authored markdown, rendered on
      // the brochure (brochure.ts). Slugs are url-safe lowercase, unique per
      // group — a duplicate is a storage CONFLICT, mapped to 409.

      const PAGE_SLUG = { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } as const;
      const PAGE_VISIBILITY = {
        type: 'string',
        enum: ['public', 'members', 'admin'],
      } as const;

      /** Assert the page exists in the request's group (tenancy isolation). */
      async function targetPage(request: FastifyRequest, id: string): Promise<Page> {
        const page = await storage.getPage(id);
        if (page.groupId !== request.group!.id) {
          throw new DomainError('NOT_FOUND', `page ${id} not found in this group`);
        }
        return page;
      }

      scope.get(
        '/admin/pages',
        {
          preHandler: [requireMember, requireAdmin],
          schema: { response: respond(200, body({ pages: arrayOf('Page') })) },
        },
        async (request) => {
          return { pages: await storage.listPages(request.group!.id) };
        },
      );

      scope.post(
        '/admin/pages',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              required: ['slug', 'title', 'body', 'visibility'],
              properties: {
                slug: PAGE_SLUG,
                title: { type: 'string' },
                body: { type: 'string' },
                visibility: PAGE_VISIBILITY,
                position: { type: 'integer' },
              },
            },
            response: respond(201, body({ page: ref('Page') })),
          },
        },
        async (request, reply) => {
          const draft = request.body as {
            slug: string;
            title: string;
            body: string;
            visibility: PageVisibility;
            position?: number;
          };
          const input: Parameters<typeof storage.createPage>[0] = {
            groupId: request.group!.id,
            slug: draft.slug,
            title: draft.title,
            body: draft.body,
            visibility: draft.visibility,
          };
          if (draft.position !== undefined) input.position = draft.position;
          const page = await storage.createPage(input);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'page.create', entityType: 'page', entityId: page.id,
            detail: { slug: page.slug },
          });
          reply.status(201);
          return { page };
        },
      );

      scope.patch(
        '/admin/pages/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            body: {
              type: 'object',
              properties: {
                slug: PAGE_SLUG,
                title: { type: 'string' },
                body: { type: 'string' },
                visibility: PAGE_VISIBILITY,
                position: { type: 'integer' },
              },
            },
            response: respond(200, body({ page: ref('Page') })),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const draft = request.body as Partial<{
            slug: string;
            title: string;
            body: string;
            visibility: PageVisibility;
            position: number;
          }>;
          await targetPage(request, id);
          const patch: Parameters<typeof storage.updatePage>[1] = {};
          if (draft.slug !== undefined) patch.slug = draft.slug;
          if (draft.title !== undefined) patch.title = draft.title;
          if (draft.body !== undefined) patch.body = draft.body;
          if (draft.visibility !== undefined) patch.visibility = draft.visibility;
          if (draft.position !== undefined) patch.position = draft.position;
          const page = await storage.updatePage(id, patch);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'page.update', entityType: 'page', entityId: id,
            detail: { slug: page.slug },
          });
          return { page };
        },
      );

      scope.delete(
        '/admin/pages/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const page = await targetPage(request, id);
          await storage.deletePage(id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'page.delete', entityType: 'page', entityId: id,
            detail: { slug: page.slug },
          });
          return { ok: true };
        },
      );

      // --- News items (decision #13): admin-authored markdown announcements
      // with a published/expires window; the brochure shows the current ones
      // publicly (brochure.ts). Admins see everything here, scheduled and
      // expired included.

      /** Assert the news item exists in the request's group (tenancy isolation). */
      async function targetNewsItem(request: FastifyRequest, id: string): Promise<NewsItem> {
        const item = await storage.getNewsItem(id);
        if (item.groupId !== request.group!.id) {
          throw new DomainError('NOT_FOUND', `news item ${id} not found in this group`);
        }
        return item;
      }

      scope.get(
        '/admin/news',
        {
          preHandler: [requireMember, requireAdmin],
          schema: { response: respond(200, body({ news: arrayOf('NewsItem') })) },
        },
        async (request) => {
          return { news: await storage.listNews(request.group!.id, {}) };
        },
      );

      scope.post(
        '/admin/news',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              required: ['title', 'body'],
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
                publishedAt: { type: 'string' },
                expiresAt: { type: 'string' },
              },
            },
            response: respond(201, body({ newsItem: ref('NewsItem') })),
          },
        },
        async (request, reply) => {
          const draft = request.body as {
            title: string;
            body: string;
            publishedAt?: string;
            expiresAt?: string;
          };
          const input: Parameters<typeof storage.createNewsItem>[0] = {
            groupId: request.group!.id,
            title: draft.title,
            body: draft.body,
            // Unscheduled news goes up immediately.
            publishedAt: draft.publishedAt ?? new Date().toISOString(),
          };
          if (draft.expiresAt !== undefined) input.expiresAt = draft.expiresAt;
          const newsItem = await storage.createNewsItem(input);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'news.create', entityType: 'news_item', entityId: newsItem.id,
          });
          reply.status(201);
          return { newsItem };
        },
      );

      scope.patch(
        '/admin/news/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            body: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
                publishedAt: { type: 'string' },
                expiresAt: { type: 'string' },
              },
            },
            response: respond(200, body({ newsItem: ref('NewsItem') })),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const draft = request.body as Partial<{
            title: string;
            body: string;
            publishedAt: string;
            expiresAt: string;
          }>;
          await targetNewsItem(request, id);
          const patch: Parameters<typeof storage.updateNewsItem>[1] = {};
          if (draft.title !== undefined) patch.title = draft.title;
          if (draft.body !== undefined) patch.body = draft.body;
          if (draft.publishedAt !== undefined) patch.publishedAt = draft.publishedAt;
          if (draft.expiresAt !== undefined) patch.expiresAt = draft.expiresAt;
          const newsItem = await storage.updateNewsItem(id, patch);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'news.update', entityType: 'news_item', entityId: id,
          });
          return { newsItem };
        },
      );

      scope.delete(
        '/admin/news/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          await targetNewsItem(request, id);
          await storage.deleteNewsItem(id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'news.delete', entityType: 'news_item', entityId: id,
          });
          return { ok: true };
        },
      );

      // --- CMS images (decision #14): admin-uploaded, referenced from page
      // and news markdown as /i/{id}. Uploads are raw request bodies (the
      // file's own content type, no multipart); responses carry metadata
      // only — the bytes are served by GET /i/{id} in brochure.ts.

      /** Assert the image exists in the request's group (tenancy isolation). */
      async function targetImage(request: FastifyRequest, id: string): Promise<Image> {
        const image = await storage.getImage(id);
        if (image.groupId !== request.group!.id) {
          throw new DomainError('NOT_FOUND', `image ${id} not found in this group`);
        }
        return image;
      }

      scope.post(
        '/admin/images',
        {
          preHandler: [requireMember, requireAdmin],
          // Raw-body route: a JSON body schema cannot describe a binary
          // upload, so only the response is declared.
          schema: { response: respond(201, body({ image: ref('Image') })) },
        },
        async (request, reply) => {
          if (!Buffer.isBuffer(request.body)) {
            throw new DomainError('INVALID', 'the request body must be the raw image bytes');
          }
          const image = await uploadImage(storage, {
            groupId: request.group!.id,
            ownerKind: 'cms',
            mime: request.headers['content-type'] ?? '',
            data: request.body,
            createdBy: request.auth!.member.id,
          });
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'image.upload', entityType: 'image', entityId: image.id,
          });
          reply.status(201);
          return { image };
        },
      );

      scope.get(
        '/admin/images',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            // ownerKind filter (#15): the Branding page lists brand slots
            // through this same route; the default keeps the Images page on
            // cms uploads only.
            querystring: {
              type: 'object',
              properties: { ownerKind: { type: 'string', enum: ['cms', 'brand'] } },
            },
            response: respond(200, body({ images: arrayOf('Image') })),
          },
        },
        async (request) => {
          const { ownerKind = 'cms' } = request.query as { ownerKind?: 'cms' | 'brand' };
          return { images: await storage.listImages(request.group!.id, { ownerKind }) };
        },
      );

      scope.delete(
        '/admin/images/:id',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: ID_PARAM_SCHEMA,
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          await targetImage(request, id);
          await storage.deleteImage(id);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'image.delete', entityType: 'image', entityId: id,
          });
          return { ok: true };
        },
      );

      // Group skinning (#15): one brand image per slot (logo | header),
      // replace-on-upload. The enum params schema makes any other slot a
      // validation 400, so the handlers only ever see real slots.
      const BRAND_SLOT_PARAMS = {
        type: 'object',
        // slug: the tenancy prefix param is part of request.params too.
        properties: {
          slug: { type: 'string' },
          slot: { type: 'string', enum: ['logo', 'header'] },
        },
        required: ['slot'],
        additionalProperties: false,
      } as const;

      scope.put(
        '/admin/branding/:slot',
        {
          preHandler: [requireMember, requireAdmin],
          // Raw-body route: a JSON body schema cannot describe a binary
          // upload, so only params and the response are declared.
          schema: {
            params: BRAND_SLOT_PARAMS,
            response: respond(200, body({ image: ref('Image') })),
          },
        },
        async (request) => {
          if (!Buffer.isBuffer(request.body)) {
            throw new DomainError('INVALID', 'the request body must be the raw image bytes');
          }
          const { slot } = request.params as { slot: BrandSlot };
          const image = await setBrandImage(
            storage,
            request.group!.id,
            slot,
            request.headers['content-type'] ?? '',
            request.body,
            request.auth!.member.id,
          );
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'branding.set', entityType: 'image', entityId: image.id,
            detail: { slot },
          });
          return { image };
        },
      );

      scope.delete(
        '/admin/branding/:slot',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: BRAND_SLOT_PARAMS,
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { slot } = request.params as { slot: BrandSlot };
          await deleteBrandImage(storage, request.group!.id, slot);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'branding.clear', entityType: 'group', entityId: request.group!.id,
            detail: { slot },
          });
          return { ok: true };
        },
      );

      // --- Group settings: name and sender address (#16, emailFrom: null
      // clears back to the instance default) plus the trading/digest knobs
      // (settings replaces the whole object; services/settings.ts fills
      // defaults for absent keys).

      scope.get(
        '/admin/group',
        {
          preHandler: [requireMember, requireAdmin],
          schema: { response: respond(200, body({ group: ref('Group') })) },
        },
        async (request) => {
          return { group: request.group! };
        },
      );

      scope.patch(
        '/admin/group',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            body: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                emailFrom: { type: ['string', 'null'] },
                settings: {
                  type: 'object',
                  additionalProperties: false, // unknown keys 400
                  properties: {
                    autoAcceptDays: { type: 'integer', minimum: 1, maximum: 365 },
                    invoiceExpiryDays: { type: 'integer', minimum: 1, maximum: 365 },
                    digestDefault: { type: 'string', enum: ['none', 'weekly', 'monthly'] },
                    listingMaxAgeDays: { type: 'integer', minimum: 1, maximum: 730 },
                    transparency: { type: 'string', enum: TRANSPARENCY }, // #19
                  },
                },
              },
            },
            response: respond(200, body({ group: ref('Group') })),
          },
        },
        async (request) => {
          const draft = request.body as {
            name?: string;
            emailFrom?: string | null;
            settings?: GroupSettings;
          };
          const patch: Parameters<typeof storage.updateGroup>[1] = {};
          if (draft.name !== undefined) patch.name = draft.name;
          if (draft.emailFrom !== undefined) patch.emailFrom = draft.emailFrom;
          if (draft.settings !== undefined) patch.settings = draft.settings;
          const group = await storage.updateGroup(request.group!.id, patch);
          await recordAudit(storage, {
            groupId: group.id, actorUserId: request.auth!.user.id,
            action: 'group.update', entityType: 'group', entityId: group.id,
          });
          return { group };
        },
      );

      // --- Email templates (#16): built-in defaults, per-group overrides.
      // The enum params schema makes any unknown kind a validation 400.

      const TEMPLATE_KIND_PARAMS = {
        type: 'object',
        // slug: the tenancy prefix param is part of request.params too.
        properties: {
          slug: { type: 'string' },
          kind: { type: 'string', enum: EMAIL_TEMPLATE_KINDS },
        },
        required: ['kind'],
        additionalProperties: false,
      } as const;

      /** The effective template per kind: override values or the default. */
      const EMAIL_TEMPLATE_VIEW = body({
        kind: { type: 'string', enum: EMAIL_TEMPLATE_KINDS },
        subject: { type: 'string' },
        body: { type: 'string' },
        isDefault: { type: 'boolean' },
      });

      scope.get(
        '/admin/email-templates',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            response: respond(
              200,
              body({ templates: { type: 'array', items: EMAIL_TEMPLATE_VIEW } }),
            ),
          },
        },
        async (request) => {
          const overrides = await storage.listEmailTemplates(request.group!.id);
          return {
            templates: EMAIL_TEMPLATE_KINDS.map((kind) => {
              const override = overrides.find((candidate) => candidate.kind === kind);
              return override === undefined
                ? { kind, ...DEFAULT_EMAIL_TEMPLATES[kind], isDefault: true }
                : { kind, subject: override.subject, body: override.body, isDefault: false };
            }),
          };
        },
      );

      scope.put(
        '/admin/email-templates/:kind',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: TEMPLATE_KIND_PARAMS,
            body: {
              type: 'object',
              required: ['subject', 'body'],
              properties: {
                subject: { type: 'string' },
                body: { type: 'string' },
              },
            },
            response: respond(200, body({ template: EMAIL_TEMPLATE_VIEW })),
          },
        },
        async (request) => {
          const { kind } = request.params as { kind: EmailTemplateKind };
          const draft = request.body as { subject: string; body: string };
          const template = await storage.setEmailTemplate({
            groupId: request.group!.id,
            kind,
            subject: draft.subject,
            body: draft.body,
          });
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'email_template.set', entityType: 'email_template', entityId: template.id,
            detail: { kind },
          });
          return {
            template: {
              kind,
              subject: template.subject,
              body: template.body,
              isDefault: false,
            },
          };
        },
      );

      scope.delete(
        '/admin/email-templates/:kind',
        {
          preHandler: [requireMember, requireAdmin],
          schema: {
            params: TEMPLATE_KIND_PARAMS,
            response: respond(200, OK_RESPONSE),
          },
        },
        async (request) => {
          const { kind } = request.params as { kind: EmailTemplateKind };
          await storage.deleteEmailTemplate(request.group!.id, kind);
          await recordAudit(storage, {
            groupId: request.group!.id, actorUserId: request.auth!.user.id,
            action: 'email_template.revert', entityType: 'email_template', entityId: kind,
            detail: { kind },
          });
          return { ok: true };
        },
      );
    };

  // Host-header tenancy (custom domains) and the /g/{slug} fallback resolve
  // to the same route set; the session cookie (path '/') works under both.
  await app.register(
    routes(async (request) => {
      const hostname = (request.headers.host ?? '').split(':')[0] ?? '';
      return storage.groupByDomain(hostname);
    }),
    { prefix: '/api/v1' },
  );
  await app.register(
    routes(async (request) => {
      const { slug } = request.params as { slug?: string };
      return slug === undefined ? undefined : storage.groupBySlug(slug);
    }),
    { prefix: '/api/v1/g/:slug' },
  );

  // --- Operator area (decision #2): platform-level provisioning, outside ---
  // any tenant. Operators are users, not members; their sessions carry no
  // member context, so these routes live outside the group-scoped plugins.

  /** Session cookie -> live operator session; 401 without one, 403 for non-operators. */
  async function requireOperator(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    const token = request.cookies[SESSION_COOKIE];
    const context = token === undefined ? undefined : await authenticate(storage, token);
    if (!context) {
      return reply
        .status(401)
        .send(errorBody('NOT_AUTHORISED', 'a valid session is required'));
    }
    if (!context.user.isOperator) {
      return reply
        .status(403)
        .send(errorBody('NOT_AUTHORISED', 'this action requires operator access'));
    }
    request.operator = context.user; // audit actor for operator actions (#20)
    return undefined;
  }

  app.post(
    '/api/v1/operator/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
          },
        },
        response: respond(200, OK_RESPONSE),
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      // Check the operator flag before opening any session: a failed operator
      // login must not leave a usable cookie behind. A non-operator account
      // counts as a login failure for throttling purposes.
      await checkThrottled(request, reply, body.email, async () => {
        const user = await verifyCredentials(storage, body.email, body.password);
        if (!user.isOperator) {
          throw new DomainError('NOT_AUTHORISED', 'this account is not an operator');
        }
      });
      const { token } = await login(storage, { email: body.email, password: body.password });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/operator/groups',
    {
      preHandler: requireOperator,
      schema: {
        body: {
          type: 'object',
          required: ['slug', 'name', 'currency'],
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            hostname: { type: 'string' },
            currency: {
              type: 'object',
              required: ['code', 'name'],
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                scale: { type: 'integer' },
                demurrageDay: { type: 'integer' },
              },
            },
            admin: {
              type: 'object',
              required: ['displayName', 'personName', 'email'],
              properties: {
                displayName: { type: 'string' },
                personName: { type: 'string' },
                email: { type: 'string' },
                password: { type: 'string' },
              },
            },
          },
        },
        response: respond(
          201,
          body(
            { group: ref('Group'), currency: ref('Currency'), admin: ref('Member') },
            ['group', 'currency'], // admin only when an initial admin was provisioned
          ),
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        slug: string;
        name: string;
        hostname?: string;
        currency: { code: string; name: string; scale?: number; demurrageDay?: number };
        admin?: { displayName: string; personName: string; email: string; password?: string };
      };
      const input: Parameters<typeof provisionGroup>[1] = {
        slug: body.slug,
        name: body.name,
        currency: body.currency,
      };
      if (body.hostname !== undefined) input.hostname = body.hostname;
      if (body.admin !== undefined) input.admin = body.admin;
      const { group, currency, admin } = await provisionGroup(storage, input);
      reply.status(201);
      return admin === undefined ? { group, currency } : { group, currency, admin };
    },
  );

  app.get(
    '/api/v1/operator/groups',
    {
      preHandler: requireOperator,
      schema: {
        // Inline variant, not ref('Group'): operator routes carry the
        // operator-private notes (#20) and each group's domains (#21).
        response: respond(
          200,
          body({ groups: { type: 'array', items: GROUP_WITH_NOTES_AND_DOMAINS } }),
        ),
      },
    },
    async () => {
      const groups = await storage.listGroups();
      return {
        groups: await Promise.all(
          groups.map(async (group) => ({
            ...group,
            domains: await storage.listGroupDomains(group.id),
          })),
        ),
      };
    },
  );

  // --- Operator group management (#20): lifecycle status, plan label, ---
  // name, private notes, and domains — every change audited with the
  // operator as actor.

  /** Target group by id; groups are few, so a scan beats a new query. */
  async function operatorGroup(id: string): Promise<Group | undefined> {
    return (await storage.listGroups()).find((group) => group.id === id);
  }

  app.patch(
    '/api/v1/operator/groups/:id',
    {
      preHandler: requireOperator,
      schema: {
        params: ID_PARAM_SCHEMA,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: GROUP_STATUS },
            plan: { type: ['string', 'null'] }, // null clears the label
            notes: { type: ['string', 'null'] }, // operator-private; null clears
          },
        },
        response: respond(200, body({ group: GROUP_WITH_NOTES_AND_DOMAINS })),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const patch = request.body as {
        name?: string;
        status?: GroupStatus;
        plan?: string | null;
        notes?: string | null;
      };
      const before = await operatorGroup(id);
      if (before === undefined) {
        return reply.status(404).send(errorBody('NOT_FOUND', 'unknown group'));
      }
      const group = await storage.updateGroup(id, patch);
      // One audit event per actual change, actor = the operator (#20).
      const audit = (action: string, detail?: Record<string, unknown>): Promise<void> =>
        recordAudit(storage, {
          groupId: id,
          actorUserId: request.operator!.id,
          action,
          entityType: 'group',
          entityId: id,
          ...(detail === undefined ? {} : { detail }),
        });
      if (patch.status !== undefined && patch.status !== before.status) {
        await audit('group.status', { status: patch.status });
      }
      if (patch.plan !== undefined && (patch.plan ?? undefined) !== before.plan) {
        await audit('group.plan', { plan: patch.plan });
      }
      if (patch.name !== undefined && patch.name !== before.name) {
        await audit('group.rename', { name: patch.name });
      }
      if (patch.notes !== undefined && (patch.notes ?? undefined) !== before.notes) {
        // No detail: the content is private, the fact of the edit is the record.
        await audit('group.notes');
      }
      // Same shape as the list (#21) so clients can fold the result back in.
      return { group: { ...group, domains: await storage.listGroupDomains(id) } };
    },
  );

  app.post(
    '/api/v1/operator/groups/:id/domains',
    {
      preHandler: requireOperator,
      schema: {
        params: ID_PARAM_SCHEMA,
        body: {
          type: 'object',
          required: ['hostname'],
          properties: { hostname: { type: 'string', minLength: 1 } },
        },
        response: respond(201, OK_RESPONSE),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { hostname } = request.body as { hostname: string };
      if ((await operatorGroup(id)) === undefined) {
        return reply.status(404).send(errorBody('NOT_FOUND', 'unknown group'));
      }
      await storage.addGroupDomain(id, hostname);
      await recordAudit(storage, {
        groupId: id,
        actorUserId: request.operator!.id,
        action: 'domain.add',
        entityType: 'domain',
        entityId: hostname,
        detail: { hostname },
      });
      reply.status(201);
      return { ok: true };
    },
  );

  app.delete(
    '/api/v1/operator/groups/:id/domains/:hostname',
    {
      preHandler: requireOperator,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'hostname'],
          properties: { id: { type: 'string' }, hostname: { type: 'string' } },
        },
        response: respond(200, OK_RESPONSE),
      },
    },
    async (request, reply) => {
      const { id, hostname } = request.params as { id: string; hostname: string };
      if ((await operatorGroup(id)) === undefined) {
        return reply.status(404).send(errorBody('NOT_FOUND', 'unknown group'));
      }
      await storage.removeGroupDomain(id, hostname);
      await recordAudit(storage, {
        groupId: id,
        actorUserId: request.operator!.id,
        action: 'domain.remove',
        entityType: 'domain',
        entityId: hostname,
        detail: { hostname },
      });
      return { ok: true };
    },
  );

  // Served as an ordinary route so it reflects everything registered above.
  // The response schema is deliberately permissive: a typed schema would make
  // the serializer filter the OpenAPI document down to declared fields.
  app.get(
    '/api/v1/openapi.json',
    {
      schema: {
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async () => app.swagger(),
  );

  return app;
}

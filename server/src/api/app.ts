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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import type { Storage, TransactionFilter } from '../storage/interface.js';
import type {
  ApiScope,
  ApiToken,
  Category,
  CreditPolicyConfig,
  CreditPolicyType,
  DemurrageBand,
  Group,
  ListingType,
  Member,
  MemberRole,
  MemberStatus,
  MemberType,
  Session,
  TxFlow,
  TxType,
  User,
} from '../types.js';
import { DomainError, type DomainErrorCode } from '../services/errors.js';
import { StorageError } from '../storage/errors.js';
import { authenticate, login, logout, register, verifyCredentials } from '../services/auth.js';
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
import { OK_RESPONSE, sharedSchemas } from './schemas.js';
import { evaluateFlags } from '../services/creditcontrol.js';
import {
  notifyRestrictionImposed,
  notifyRestrictionLifted,
} from '../services/notifications.js';
import { browse, postListing } from '../services/marketplace.js';
import { LoginThrottle } from '../services/ratelimit.js';
import { buildMcpServer, type RestClient } from '../mcp/server.js';
import {
  SESSION_COOKIE,
  appShellFragment,
  registerBrochureRoutes,
  resolveGroupFromHost,
  sessionMemberName,
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
    auth?: { user: User; session?: Session; member: Member; token?: ApiToken };
  }
  interface FastifyContextConfig {
    // Routes opt in to API-token access by listing acceptable scopes
    // (decision #9); routes without a scopes config are cookie-only.
    scopes?: ApiScope[];
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  WRONG_STATE: 409,
  NOT_AUTHORISED: 403,
  RESTRICTED: 403,
  SUSPENDED: 403,
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

/** Directory projection: public profile fields only (no private settings). */
export interface PublicMember {
  id: string;
  memberNo: number;
  displayName: string;
  type: MemberType;
  status: MemberStatus;
}

function publicMember(member: Member): PublicMember {
  return {
    id: member.id,
    memberNo: member.memberNo,
    displayName: member.displayName,
    type: member.type,
    status: member.status,
  };
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
  };
}

export async function buildApp(
  storage: Storage,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify();

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

  // The member app's index.html, read once; every /app navigation serves it
  // with the shell chrome injected after <body> (decision #12). An unknown
  // host still serves the app — under a generic brand — and lets login fail
  // gracefully there.
  let memberIndexCache: string | undefined;
  async function serveAppShell(
    dist: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    memberIndexCache ??= await readFile(join(dist, 'index.html'), 'utf8');
    const group = await resolveGroupFromHost(storage, request);
    const memberName =
      group === undefined ? undefined : await sessionMemberName(storage, request, group.id);
    const shell = appShellFragment(group?.name ?? 'Silvio', memberName);
    const html = memberIndexCache.replace('<body>', `<body>\n${shell}`);
    return reply.type('text/html; charset=utf-8').send(html);
  }

  if (memberDist !== undefined) {
    // index: false so the wildcard never serves the raw index.html; the
    // explicit /app/ route below wins over the static /app/* wildcard and
    // deep links fall through to the not-found handler — both shell-wrapped.
    await app.register(fastifyStatic, { root: memberDist, prefix: '/app/', index: false });
    app.get('/app/', { schema: { hide: true } }, (request, reply) =>
      serveAppShell(memberDist, request, reply));
  }
  if (adminDist !== undefined) {
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: '/admin/',
      decorateReply: memberDist === undefined,
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
      if (memberDist !== undefined && path.startsWith('/app')) {
        return serveAppShell(memberDist, request, reply);
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
      return reply.status(400).send(errorBody('INVALID', err.message));
    }
    if (err.validation) {
      return reply.status(400).send(errorBody('INVALID', err.message));
    }
    app.log.error(err);
    return reply.status(500).send(errorBody('INTERNAL', 'internal server error'));
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
              body({ member: ref('Member'), accounts: arrayOf('AccountBalance') }),
            ),
          },
        },
        async (request) => {
        const member = request.auth!.member;
        const currencies = new Map(
          (await storage.listCurrencies(request.group!.id)).map((currency) => [
            currency.id,
            currency,
          ]),
        );
        const accounts = [];
        for (const account of await storage.accountsForMember(member.id)) {
          const currency = currencies.get(account.currencyId);
          accounts.push({
            id: account.id,
            currencyId: account.currencyId,
            currencyCode: currency?.code ?? '',
            scale: currency?.scale ?? 0,
            balance: await storage.balance(account.id),
          });
        }
        return { member, accounts };
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
              },
            },
            response: respond(200, body({ member: ref('Member') })),
          },
        },
        async (request) => {
          const body = request.body as { confirmIncoming?: boolean; displayName?: string };
          const patch: Parameters<typeof storage.updateMember>[1] = {};
          if (body.confirmIncoming !== undefined) patch.confirmIncoming = body.confirmIncoming;
          if (body.displayName !== undefined) patch.displayName = body.displayName;
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
              properties: { currencyId: { type: 'string' } },
            },
            response: respond(200, body({ lines: arrayOf('StatementLine') })),
          },
        },
        async (request) => {
          const { currencyId } = request.query as { currencyId: string };
          const accounts = await storage.accountsForMember(request.auth!.member.id);
          const account = accounts.find((candidate) => candidate.currencyId === currencyId);
          if (!account) return { lines: [] };
          return { lines: await storage.statement(account.id) };
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

      // directory:read (decision #9): the public member directory.
      const directoryRead: ApiScope[] = ['directory:read'];
      scope.get(
        '/members',
        {
          preHandler: requireMember,
          config: { scopes: directoryRead },
          schema: { response: respond(200, body({ members: arrayOf('PublicMember') })) },
        },
        async (request) => {
          const members = await storage.listMembers(request.group!.id, 'active');
          return { members: members.map(publicMember) };
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
              body({ member: ref('PublicMember'), stats: ref('TradeStats') }),
            ),
          },
        },
        async (request) => {
          const { id } = request.params as { id: string };
          const member = await storage.getMember(id);
          if (member.groupId !== request.group!.id) {
            throw new DomainError('NOT_FOUND', `member ${id} not found in this group`);
          }
          return { member: publicMember(member), stats: await storage.tradeStats(id) };
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
          return { listings: await browse(storage, request.group!.id, filter) };
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

      // --- API token management (decision #9) -------------------------------
      // Cookie-only by design (no scopes config): a token must never mint,
      // list, or revoke tokens. The raw value appears exactly once, in the
      // creation response; listings expose ApiToken records, never the hash.

      scope.post(
        '/me/tokens',
        {
          preHandler: requireMember,
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
          preHandler: requireMember,
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
            return { member: await service(storage, id) };
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
          return { member: await storage.updateMember(id, { role }) };
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
          return { policy: await storage.updateCreditPolicy(id, patch) };
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
          return { bands: await storage.demurrageBands(currencyId) };
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
          reply.status(201);
          return { transaction };
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
          return { category: await storage.updateCategory(id, patch) };
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
      schema: { response: respond(200, body({ groups: arrayOf('Group') })) },
    },
    async () => {
      return { groups: await storage.listGroups() };
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

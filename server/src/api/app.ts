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
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import type { Storage } from '../storage/interface.js';
import type {
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
import { evaluateFlags } from '../services/creditcontrol.js';
import { browse, postListing } from '../services/marketplace.js';
import { LoginThrottle } from '../services/ratelimit.js';

const SESSION_COOKIE = 'silvio_session';

declare module 'fastify' {
  interface FastifyRequest {
    group?: Group;
    auth?: { user: User; session: Session; member: Member };
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

/** Directory projection: public profile fields only (no private settings). */
interface PublicMember {
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
interface PendingItem {
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
    memberDist?: string; // built member app, served at / (decision #11)
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
    if (originHost.toLowerCase() !== host.toLowerCase()) {
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
  });

  // Same-origin UI serving (decision #11): static files + SPA fallback per
  // app; /api/* is never swallowed by the fallback.
  const memberDist = opts.ui?.memberDist;
  const adminDist = opts.ui?.adminDist;
  if (memberDist !== undefined) {
    await app.register(fastifyStatic, { root: memberDist, prefix: '/' });
  }
  if (adminDist !== undefined) {
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: '/admin/',
      decorateReply: memberDist === undefined,
    });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/api/')) {
      if (adminDist !== undefined && path.startsWith('/admin')) {
        return reply.sendFile('index.html', adminDist);
      }
      if (memberDist !== undefined) {
        return reply.sendFile('index.html', memberDist);
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

  /** Session cookie -> live auth context in this request's group; 401/403 otherwise. */
  async function requireMember(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
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

      scope.post('/auth/logout', async (request, reply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (token !== undefined) await logout(storage, token);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return { ok: true };
      });

      scope.get('/me', { preHandler: requireMember }, async (request) => {
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
          schema: {
            querystring: {
              type: 'object',
              required: ['currencyId'],
              properties: { currencyId: { type: 'string' } },
            },
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

      scope.get('/me/pending', { preHandler: requireMember }, async (request) => {
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
        return { pending };
      });

      scope.get('/members', { preHandler: requireMember }, async (request) => {
        const members = await storage.listMembers(request.group!.id, 'active');
        return { members: members.map(publicMember) };
      });

      scope.get(
        '/members/:id',
        { preHandler: requireMember, schema: { params: ID_PARAM_SCHEMA } },
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

      scope.post(
        '/payments',
        {
          preHandler: requireMember,
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
          },
        },
        async (request, reply) => {
          const body = request.body as {
            payeeMemberId: string;
            currencyId: string;
            amount: number;
            description?: string;
          };
          const input: Parameters<typeof sendPayment>[1] = {
            groupId: request.group!.id,
            payerMemberId: request.auth!.member.id,
            payeeMemberId: body.payeeMemberId,
            currencyId: body.currencyId,
            amount: body.amount,
            actorPersonId: request.auth!.user.id,
            channel: 'web',
          };
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
          },
        },
        async (request, reply) => {
          const body = request.body as {
            payerMemberId: string;
            currencyId: string;
            amount: number;
            description?: string;
          };
          const input: Parameters<typeof requestPayment>[1] = {
            groupId: request.group!.id,
            payeeMemberId: request.auth!.member.id,
            payerMemberId: body.payerMemberId,
            currencyId: body.currencyId,
            amount: body.amount,
            actorPersonId: request.auth!.user.id,
            channel: 'web',
          };
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
          { preHandler: requireMember, schema: { params: ID_PARAM_SCHEMA } },
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

      scope.get('/categories', async (request) => {
        return { categories: await storage.listCategories(request.group!.id) };
      });

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
          { preHandler: [requireMember, requireAdmin], schema: { params: ID_PARAM_SCHEMA } },
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
        { preHandler: [requireMember, requireAdmin] },
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
        { preHandler: [requireMember, requireAdmin], schema: { params: CURRENCY_PARAM_SCHEMA } },
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
          },
        },
        async (request) => {
          const { currencyId } = request.params as { currencyId: string };
          const body = request.body as { bands: DemurrageBand[] };
          await storage.setDemurrageBands(currencyId, body.bands);
          return { bands: await storage.demurrageBands(currencyId) };
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
          },
        },
        async (request) => {
          const { memberId } = request.params as { memberId: string };
          await storage.liftRestriction(memberId, request.auth!.member.id);
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
          },
        },
        async (request) => {
          const { currencyId } = request.query as { currencyId: string };
          return { flags: await evaluateFlags(storage, request.group!.id, currencyId) };
        },
      );

      scope.post(
        '/admin/transactions/:id/reverse',
        { preHandler: [requireMember, requireAdmin], schema: { params: ID_PARAM_SCHEMA } },
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

  app.get('/api/v1/operator/groups', { preHandler: requireOperator }, async () => {
    return { groups: await storage.listGroups() };
  });

  // Served as an ordinary route so it reflects everything registered above.
  app.get('/api/v1/openapi.json', async () => app.swagger());

  return app;
}

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
import type { Storage } from '../storage/interface.js';
import type { Group, ListingType, Member, Session, User } from '../types.js';
import { DomainError, type DomainErrorCode } from '../services/errors.js';
import { StorageError } from '../storage/errors.js';
import { authenticate, login, logout, register } from '../services/auth.js';
import { apply, approve } from '../services/membership.js';
import { accept, cancel, decline, requestPayment, sendPayment } from '../services/trading.js';
import { browse, postListing } from '../services/marketplace.js';

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
};

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

type ResolveGroup = (request: FastifyRequest) => Promise<Group | undefined>;

const ID_PARAM_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
} as const;

export async function buildApp(storage: Storage): Promise<FastifyInstance> {
  const app = Fastify();

  await app.register(cookie);
  await app.register(swagger, {
    openapi: { info: { title: 'Silvio', version: '0.1' } },
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
          const { token } = await login(storage, {
            email: body.email,
            password: body.password,
            groupId: request.group!.id,
          });
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
        const codes = new Map(
          (await storage.listCurrencies(request.group!.id)).map((currency) => [
            currency.id,
            currency.code,
          ]),
        );
        const accounts = [];
        for (const account of await storage.accountsForMember(member.id)) {
          accounts.push({
            id: account.id,
            currencyId: account.currencyId,
            currencyCode: codes.get(account.currencyId) ?? '',
            balance: await storage.balance(account.id),
          });
        }
        return { member, accounts };
      });

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

      scope.post(
        '/admin/members/:id/approve',
        { preHandler: [requireMember, requireAdmin], schema: { params: ID_PARAM_SCHEMA } },
        async (request) => {
          const { id } = request.params as { id: string };
          const target = await storage.getMember(id);
          if (target.groupId !== request.group!.id) {
            throw new DomainError('NOT_FOUND', `member ${id} not found in this group`);
          }
          return { member: await approve(storage, id) };
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

  // Served as an ordinary route so it reflects everything registered above.
  app.get('/api/v1/openapi.json', async () => app.swagger());

  return app;
}

// Response schemas in route definitions (todo: API polish). Every route must
// declare its success-response shape so (a) the OpenAPI document carries
// response types and ui/shared can generate its types instead of hand-writing
// them, and (b) Fastify's serializer becomes a leak guard: undeclared fields
// are never sent (the PublicMember projection is enforced structurally).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group, Member } from '../../src/types.js';

interface OpenApiOperation {
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
}

interface OpenApiDoc {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('response schemas (API polish)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let cookie: string;

  async function makeMember(name: string): Promise<Member> {
    const email = `${name.toLowerCase()}@example.com`;
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    await makeMember('Bob');
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'password-Alice', groupId: group.id,
    });
    cookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  async function openapi(): Promise<OpenApiDoc> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    return res.json() as OpenApiDoc;
  }

  describe('OpenAPI document', () => {
    it('every visible operation declares a success response schema', async () => {
      const doc = await openapi();
      const missing: string[] = [];
      for (const [path, operations] of Object.entries(doc.paths)) {
        for (const method of METHODS) {
          const op = operations[method];
          if (!op) continue;
          const success = Object.entries(op.responses ?? {}).find(([status]) =>
            status.startsWith('2'),
          );
          const schema = success?.[1].content?.['application/json']?.schema;
          if (!schema) missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(missing).toEqual([]);
    });

    it('publishes the domain shapes as named components', async () => {
      const { components } = await openapi();
      for (const name of [
        'Member', 'PublicMember', 'Transaction', 'StatementLine', 'PendingItem',
        'Group', 'Currency', 'ErrorResponse',
      ]) {
        expect(components.schemas, `missing component ${name}`).toHaveProperty(name);
      }
    });

    it('PublicMember never declares private fields', async () => {
      const { components } = await openapi();
      const publicMember = components.schemas['PublicMember'] as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(publicMember.properties).sort()).toEqual([
        'displayName', 'id', 'memberNo', 'status', 'type',
      ]);
    });

    it('declares the shared error shape on a 4xx response', async () => {
      const doc = await openapi();
      // Spot check: /me carries a 401 that references ErrorResponse.
      const mePath = Object.keys(doc.paths).find((p) => p.endsWith('/me'));
      expect(mePath).toBeDefined();
      const responses = doc.paths[mePath!]!['get']!.responses!;
      const error = responses['401'] ?? responses['4XX'];
      expect(error, 'GET /me must document its error response').toBeDefined();
      expect(JSON.stringify(error)).toContain('ErrorResponse');
    });
  });

  describe('serialization behaviour', () => {
    it('GET /members sends exactly the PublicMember fields (leak guard)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/members', headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const { members } = res.json() as { members: Record<string, unknown>[] };
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) {
        expect(Object.keys(member).sort()).toEqual([
          'displayName', 'id', 'memberNo', 'status', 'type',
        ]);
      }
    });

    it('GET /me still carries every documented field after serialization', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/me', headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        member: Record<string, unknown>;
        accounts: Record<string, unknown>[];
      };
      // The schema must not silently drop real fields (fast-json-stringify
      // omits anything undeclared).
      for (const key of [
        'id', 'groupId', 'memberNo', 'type', 'role', 'displayName', 'status',
        'confirmIncoming', 'appliedAt', 'approvedAt',
      ]) {
        expect(body.member, `member.${key} was dropped`).toHaveProperty(key);
      }
      expect(body.member['id']).toBe(alice.id);
      for (const key of ['id', 'currencyId', 'currencyCode', 'scale', 'balance']) {
        expect(body.accounts[0], `accounts[].${key} was dropped`).toHaveProperty(key);
      }
    });

    it('POST /payments still returns the full transaction with entries', async () => {
      const bobId = (await storage.listMembers(group.id, 'active')).find(
        (m) => m.displayName === 'Bob',
      )!.id;
      const res = await app.inject({
        method: 'POST', url: '/api/v1/g/cam/payments',
        headers: { cookie },
        payload: {
          payeeMemberId: bobId, currencyId: cams.id, amount: 500, description: 'veg',
        },
      });
      expect(res.statusCode).toBe(201);
      const { transaction } = res.json() as { transaction: Record<string, unknown> };
      for (const key of [
        'id', 'groupId', 'type', 'state', 'seq', 'hash', 'createdBy', 'channel',
        'createdAt', 'committedAt', 'description', 'entries',
      ]) {
        expect(transaction, `transaction.${key} was dropped`).toHaveProperty(key);
      }
      const entries = transaction['entries'] as Record<string, unknown>[];
      expect(entries).toHaveLength(2);
      for (const key of ['id', 'transactionId', 'accountId', 'amount']) {
        expect(entries[0], `entries[].${key} was dropped`).toHaveProperty(key);
      }
    });

    it('error responses keep the shared shape', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/g/cam/me' });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { error: { code: string; message: string } };
      expect(Object.keys(body).sort()).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    });
  });
});

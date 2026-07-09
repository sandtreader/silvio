// The MCP server (decision #9): a thin client of the same REST API, served
// as a Streamable HTTP endpoint at {tenancy}/mcp, authenticated by bearer
// API token. Tools are filtered by the token's scopes; trade:request
// payments come back pending for confirmation in the web UI.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildApp } from '../../src/api/app.js';
import { register } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { issueApiToken, type IssueTokenInput } from '../../src/services/tokens.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { ApiScope, Category, Currency, Group, Member, Person } from '../../src/types.js';

const ALL_SCOPES: ApiScope[] = [
  'marketplace:read', 'directory:read', 'account:read',
  'listings:write', 'trade:request', 'trade:autonomous',
];

interface TextResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe('MCP endpoint (#9)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let baseUrl: string;
  let group: Group;
  let cams: Currency;
  let misc: Category;
  let alice: Member;
  let alicePerson: Person;
  let bob: Member;
  let clients: Client[];

  async function makeMember(name: string): Promise<{ member: Member; person: Person }> {
    // Tokens are minted from a logged-in profile page, so the issuing person
    // always has a login user behind it — mirror that here.
    const user = await register(storage, {
      email: `${name.toLowerCase()}@example.com`,
      password: `password-${name}`,
    });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name,
      email: `${name.toLowerCase()}@example.com`, userId: user.id,
    });
    return { member: await approve(storage, applied.member.id), person: applied.person };
  }

  async function aliceToken(
    overrides: Omit<Partial<IssueTokenInput>, 'maxTxAmount'> & {
      maxTxAmount?: number | undefined;
    } = {},
  ): Promise<string> {
    const input: IssueTokenInput = {
      memberId: alice.id,
      createdBy: alicePerson.id,
      label: 'test agent',
      scopes: overrides.scopes ?? ALL_SCOPES,
    };
    // An explicit `maxTxAmount: undefined` override drops the default cap.
    const maxTxAmount = 'maxTxAmount' in overrides ? overrides.maxTxAmount : 100_000;
    if (maxTxAmount !== undefined) input.maxTxAmount = maxTxAmount;
    if (overrides.maxPeriodAmount !== undefined) input.maxPeriodAmount = overrides.maxPeriodAmount;
    if (overrides.periodDays !== undefined) input.periodDays = overrides.periodDays;
    const { token } = await issueApiToken(storage, input);
    return token;
  }

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    // The SDK's d.ts is not exactOptionalPropertyTypes-clean; no-op at runtime.
    await client.connect(transport as Transport);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    clients = [];
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    misc = await storage.createCategory({ groupId: group.id, name: 'Misc' });
    ({ member: alice, person: alicePerson } = await makeMember('Alice'));
    ({ member: bob } = await makeMember('Bob'));
    app = await buildApp(storage);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1/g/cam`;
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await app.close();
    storage.close();
  });

  describe('authentication', () => {
    it('rejects a missing bearer token with 401', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects an invalid bearer token', async () => {
      await expect(connect('slv_deadbeef')).rejects.toThrow();
    });

    it('connects and initialises with a valid token', async () => {
      const client = await connect(await aliceToken());
      expect(client.getServerVersion()?.name).toBeTruthy();
    });
  });

  describe('tool listing follows token scopes', () => {
    it('a full-scope token sees every tool', async () => {
      const client = await connect(await aliceToken());
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'create_invoice', 'create_listing', 'list_categories', 'member_directory',
        'my_account', 'my_statement', 'pending_items', 'search_marketplace',
        'send_payment',
      ]);
    });

    it('an account:read-only token sees account and marketplace tools only', async () => {
      const client = await connect(
        await aliceToken({ scopes: ['account:read'] as ApiScope[], maxTxAmount: undefined }),
      );
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'list_categories', 'my_account', 'my_statement', 'pending_items',
        'search_marketplace',
      ]);
    });
  });

  describe('read tools', () => {
    it('my_account returns the member and balances', async () => {
      const client = await connect(await aliceToken());
      const result = (await client.callTool({ name: 'my_account', arguments: {} })) as TextResult;
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0]!.text) as {
        member: { id: string }; accounts: unknown[];
      };
      expect(body.member.id).toBe(alice.id);
    });

    it('search_marketplace finds listings', async () => {
      await postListing(storage, bob.id, {
        type: 'offer', title: 'Bike repair', description: 'All kinds', categoryId: misc.id,
      });
      const client = await connect(await aliceToken());
      const result = (await client.callTool({
        name: 'search_marketplace', arguments: { type: 'offer' },
      })) as TextResult;
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain('Bike repair');
    });

    it('member_directory lists active members', async () => {
      const client = await connect(await aliceToken());
      const result = (await client.callTool({
        name: 'member_directory', arguments: {},
      })) as TextResult;
      expect(result.content[0]!.text).toContain('Bob');
    });
  });

  describe('send_payment', () => {
    it('with trade:request the payment lands pending and says so', async () => {
      const client = await connect(
        await aliceToken({ scopes: ['trade:request'] as ApiScope[], maxTxAmount: undefined }),
      );
      const result = (await client.callTool({
        name: 'send_payment',
        arguments: {
          payeeMemberId: bob.id, currencyId: cams.id, amount: 2000, description: 'agent buy',
        },
      })) as TextResult;
      expect(result.isError).toBeFalsy();
      const text = result.content[0]!.text;
      expect(text.toLowerCase()).toContain('pending');
      expect(text.toLowerCase()).toContain('confirm');

      const pending = await storage.pendingForMember(alice.id);
      expect(pending).toHaveLength(1);
      // No balance movement without the member's confirmation.
      const accounts = await storage.accountsForMember(alice.id);
      expect(await storage.balance(accounts[0]!.id)).toBe(0);
    });

    it('with trade:autonomous the payment commits within caps', async () => {
      const client = await connect(
        await aliceToken({ scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000 }),
      );
      const result = (await client.callTool({
        name: 'send_payment',
        arguments: { payeeMemberId: bob.id, currencyId: cams.id, amount: 3000 },
      })) as TextResult;
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text.toLowerCase()).toContain('committed');
      const accounts = await storage.accountsForMember(alice.id);
      expect(await storage.balance(accounts[0]!.id)).toBe(-3000);
    });

    it('a cap breach comes back as a tool error naming the cap', async () => {
      const client = await connect(
        await aliceToken({ scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000 }),
      );
      const result = (await client.callTool({
        name: 'send_payment',
        arguments: { payeeMemberId: bob.id, currencyId: cams.id, amount: 5001 },
      })) as TextResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('5000');
      const accounts = await storage.accountsForMember(alice.id);
      expect(await storage.balance(accounts[0]!.id)).toBe(0);
    });
  });

  describe('create_invoice and create_listing', () => {
    it('creates a pending invoice for the counterparty to confirm', async () => {
      const client = await connect(await aliceToken());
      const result = (await client.callTool({
        name: 'create_invoice',
        arguments: {
          payerMemberId: bob.id, currencyId: cams.id, amount: 1500, description: 'work done',
        },
      })) as TextResult;
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text.toLowerCase()).toContain('pending');
      expect(await storage.pendingForMember(bob.id)).toHaveLength(1);
    });

    it('creates a listing', async () => {
      const client = await connect(await aliceToken());
      const result = (await client.callTool({
        name: 'create_listing',
        arguments: {
          type: 'offer', title: 'Jam jars', description: 'Dozens spare', categoryId: misc.id,
        },
      })) as TextResult;
      expect(result.isError).toBeFalsy();
      const listings = await storage.listListings(group.id, { memberId: alice.id });
      expect(listings.map((l) => l.title)).toContain('Jam jars');
    });

    it('a scope the token lacks stays enforced at the REST layer even if called', async () => {
      // Belt and braces: the tool isn't listed, but a direct call must still 403.
      const client = await connect(
        await aliceToken({ scopes: ['account:read'] as ApiScope[], maxTxAmount: undefined }),
      );
      const result = (await client.callTool({
        name: 'create_listing',
        arguments: {
          type: 'offer', title: 'Sneaky', description: 'x', categoryId: misc.id,
        },
      }).catch((e: unknown) => e)) as TextResult | Error;
      // Either the server refuses the unknown tool or the REST layer 403s —
      // in both cases nothing is created.
      const listings = await storage.listListings(group.id, { memberId: alice.id });
      expect(listings).toHaveLength(0);
      expect(result).toBeDefined();
    });
  });
});

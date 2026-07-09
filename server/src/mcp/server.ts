// MCP server (decision #9): a thin client of the same REST API the web UI
// uses (API-first). Every tool call is forwarded to a REST route with the
// caller's bearer token, so scope checks, trade caps, and audit logging
// apply identically over MCP — the tool layer adds no authority of its own.
// The tool list itself is filtered by the token's scopes so agents only see
// what they can use; the REST layer stays the real enforcement boundary.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiScope } from '../types.js';

/** Minimal REST forwarding interface; the API layer implements it with inject(). */
export interface RestClient {
  call(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: string }>;
}

interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

/** Pull the REST error envelope's message; fall back to the raw body. */
function restErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
  } catch {
    // not JSON — fall through to the raw body
  }
  return body;
}

export function buildMcpServer(opts: { scopes: ApiScope[]; rest: RestClient }): McpServer {
  const { scopes, rest } = opts;
  const has = (scope: ApiScope): boolean => scopes.includes(scope);
  const server = new McpServer({ name: 'silvio', version: '0.0.1' });

  /**
   * Forward to the REST API and shape the tool result: non-2xx becomes a
   * tool error carrying the REST error message; 2xx becomes pretty-printed
   * JSON, optionally led by a status line derived from the response body.
   */
  async function forward(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    statusLine?: (body: unknown) => string | undefined,
  ): Promise<ToolResult> {
    const res = await rest.call(method, path, payload);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { isError: true, content: [{ type: 'text', text: restErrorText(res.body) }] };
    }
    const body = JSON.parse(res.body) as unknown;
    const pretty = JSON.stringify(body, null, 2);
    const line = statusLine?.(body);
    return {
      content: [{ type: 'text', text: line === undefined ? pretty : `${line}\n\n${pretty}` }],
    };
  }

  // Marketplace browsing is member-visible over any token, so these two are
  // always registered regardless of scopes.
  server.registerTool(
    'search_marketplace',
    {
      description:
        'Search the group marketplace for offers and wants. Optionally filter ' +
        'by listing type and/or category id (see list_categories). Listing ' +
        'prices are integer minor units of the currency.',
      inputSchema: {
        type: z.enum(['offer', 'want']).optional().describe('Only offers or only wants'),
        categoryId: z.string().optional().describe('Filter to one category id'),
      },
    },
    async ({ type, categoryId }) => {
      const query = new URLSearchParams();
      if (type !== undefined) query.set('type', type);
      if (categoryId !== undefined) query.set('categoryId', categoryId);
      const qs = query.toString();
      return forward('GET', qs === '' ? '/listings' : `/listings?${qs}`);
    },
  );

  server.registerTool(
    'list_categories',
    { description: 'List the marketplace categories of this group, with their ids.' },
    async () => forward('GET', '/categories'),
  );

  if (has('directory:read')) {
    server.registerTool(
      'member_directory',
      { description: 'List the active members of this group (public profile fields only).' },
      async () => forward('GET', '/members'),
    );
  }

  if (has('account:read')) {
    server.registerTool(
      'my_account',
      {
        description:
          'Show the member this token acts for, with account balances. ' +
          'Balances are integer minor units of each currency (see the scale field).',
      },
      async () => forward('GET', '/me'),
    );

    server.registerTool(
      'my_statement',
      {
        description:
          'Full statement of this member\'s account in one currency. Amounts ' +
          'are integer minor units of the currency.',
        inputSchema: {
          currencyId: z.string().describe('The currency id (see my_account)'),
        },
      },
      async ({ currencyId }) =>
        forward('GET', `/me/statement?currencyId=${encodeURIComponent(currencyId)}`),
    );

    server.registerTool(
      'pending_items',
      {
        description:
          'List this member\'s pending transactions awaiting confirmation, ' +
          'with the actions available on each (accept, decline, cancel).',
      },
      async () => forward('GET', '/me/pending'),
    );
  }

  if (has('listings:write')) {
    server.registerTool(
      'create_listing',
      {
        description:
          'Post a new offer or want to the marketplace as this member. ' +
          'priceAmount, if given, is an integer in minor units of priceCurrencyId; ' +
          'rateText is a free-text alternative (for example "20 cams/hour").',
        inputSchema: {
          type: z.enum(['offer', 'want']),
          title: z.string(),
          description: z.string(),
          categoryId: z.string().describe('A category id from list_categories'),
          priceAmount: z.number().int().optional().describe('Integer minor units'),
          priceCurrencyId: z.string().optional(),
          rateText: z.string().optional(),
        },
      },
      async ({ type, title, description, categoryId, priceAmount, priceCurrencyId, rateText }) => {
        const payload: Record<string, unknown> = { type, title, description, categoryId };
        if (priceAmount !== undefined) payload['priceAmount'] = priceAmount;
        if (priceCurrencyId !== undefined) payload['priceCurrencyId'] = priceCurrencyId;
        if (rateText !== undefined) payload['rateText'] = rateText;
        return forward('POST', '/listings', payload);
      },
    );
  }

  if (has('trade:request') || has('trade:autonomous')) {
    server.registerTool(
      'send_payment',
      {
        description:
          'Pay another member. amount is an integer in minor units of the ' +
          'currency (for example 2000 = 20.00 at scale 2). With trade:request ' +
          'the payment enters pending and the member must confirm it in the ' +
          'Silvio web app; with trade:autonomous it commits directly, within ' +
          'the token\'s caps.',
        inputSchema: {
          payeeMemberId: z.string().describe('The receiving member\'s id'),
          currencyId: z.string(),
          amount: z.number().int().describe('Integer minor units of the currency'),
          description: z.string().optional(),
        },
      },
      async ({ payeeMemberId, currencyId, amount, description }) => {
        const payload: Record<string, unknown> = { payeeMemberId, currencyId, amount };
        if (description !== undefined) payload['description'] = description;
        return forward('POST', '/payments', payload, (body) => {
          const state = (body as { transaction?: { state?: string } }).transaction?.state;
          if (state === 'pending') {
            return (
              'Payment is PENDING — the member must confirm it in the Silvio ' +
              'web app before it takes effect.'
            );
          }
          if (state === 'committed') return 'Payment COMMITTED.';
          return undefined;
        });
      },
    );

    server.registerTool(
      'create_invoice',
      {
        description:
          'Invoice another member (request a payment from them). amount is an ' +
          'integer in minor units of the currency. The invoice is pending until ' +
          'the payer confirms it in the Silvio web app.',
        inputSchema: {
          payerMemberId: z.string().describe('The member to be charged'),
          currencyId: z.string(),
          amount: z.number().int().describe('Integer minor units of the currency'),
          description: z.string().optional(),
        },
      },
      async ({ payerMemberId, currencyId, amount, description }) => {
        const payload: Record<string, unknown> = { payerMemberId, currencyId, amount };
        if (description !== undefined) payload['description'] = description;
        return forward(
          'POST',
          '/invoices',
          payload,
          () => 'Invoice created, PENDING the payer\'s confirmation.',
        );
      },
    );
  }

  return server;
}

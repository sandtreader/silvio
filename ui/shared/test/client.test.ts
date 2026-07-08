import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/client.js';

/** A fetch stub that records calls and returns a canned response. */
function stubFetch(
  status = 200,
  body: unknown = {},
  statusText = 'OK',
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      statusText,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function lastCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = mock.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('path construction', () => {
  it('uses hostname mode when no group is set', async () => {
    const mock = stubFetch(200, { member: {}, accounts: [] });
    await new ApiClient().me();
    expect(lastCall(mock).url).toBe('/api/v1/me');
  });

  it('uses /g/{slug} path mode when a group is set', async () => {
    const mock = stubFetch(200, { member: {}, accounts: [] });
    await new ApiClient({ group: 'camlets' }).me();
    expect(lastCall(mock).url).toBe('/api/v1/g/camlets/me');
  });

  it('prefixes baseUrl and strips its trailing slash', async () => {
    const mock = stubFetch(200, { pending: [] });
    await new ApiClient({ baseUrl: 'http://localhost:1862/', group: 'camlets' }).pending();
    expect(lastCall(mock).url).toBe('http://localhost:1862/api/v1/g/camlets/me/pending');
  });

  it('exposes groupPath for both modes', () => {
    expect(new ApiClient().groupPath()).toBe('/api/v1');
    expect(new ApiClient({ group: 'camlets' }).groupPath()).toBe('/api/v1/g/camlets');
  });

  it('always sends credentials: include', async () => {
    const mock = stubFetch(200, { ok: true });
    await new ApiClient({ group: 'camlets' }).logout();
    expect(lastCall(mock).init.credentials).toBe('include');
  });

  it('sends JSON bodies with the content-type header', async () => {
    const mock = stubFetch(200, { ok: true });
    await new ApiClient({ group: 'camlets' }).login('a@b.c', 'pw');
    const { url, init } = lastCall(mock);
    expect(url).toBe('/api/v1/g/camlets/auth/login');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.c', password: 'pw' });
  });

  it('builds query strings for statement and flags', async () => {
    const mock = stubFetch(200, { lines: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.statement('cur-1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/statement?currencyId=cur-1');
    await client.adminFlags('cur 2'); // encoding
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/flags?currencyId=cur+2');
  });

  it('builds listing browse filters, omitting the query when empty', async () => {
    const mock = stubFetch(200, { listings: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.browse();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/listings');
    await client.browse({ type: 'offer', categoryId: 'c9' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/listings?type=offer&categoryId=c9');
  });

  it('routes transaction and member actions', async () => {
    const mock = stubFetch(200, { transaction: {} });
    const client = new ApiClient({ group: 'g1' });
    await client.txAction('tx-1', 'accept');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/transactions/tx-1/accept');
    await client.adminMemberAction('m-1', 'suspend');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/members/m-1/suspend');
    await client.adminReverse('tx-2');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/transactions/tx-2/reverse');
  });

  it('encodes path parameters', async () => {
    const mock = stubFetch(200, { member: {}, stats: {} });
    await new ApiClient({ group: 'g1' }).member('id/with?chars');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/members/id%2Fwith%3Fchars');
  });

  it('creates and updates categories on the admin routes', async () => {
    const mock = stubFetch(201, { category: {} });
    const client = new ApiClient({ group: 'g1' });
    await client.adminCreateCategory({ name: 'Food', parentId: 'cat-0' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/categories');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      name: 'Food',
      parentId: 'cat-0',
    });
    await client.adminCreateCategory({ name: 'Tools' });
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({ name: 'Tools' });
    await client.adminUpdateCategory('cat/9', { name: 'Garden' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/categories/cat%2F9');
    expect(lastCall(mock).init.method).toBe('PATCH');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({ name: 'Garden' });
  });

  it('uses admin routes with the right methods', async () => {
    const mock = stubFetch(200, { bands: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.adminGetBands('cur-1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/demurrage/cur-1/bands');
    expect(lastCall(mock).init.method).toBe('GET');
    await client.adminSetBands('cur-1', [{ fromAmount: 0, ratePpmPerMonth: 5000 }]);
    expect(lastCall(mock).init.method).toBe('PUT');
    await client.adminUnrestrict('m-1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/restrictions/m-1');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('keeps operator routes outside any tenant, even with a group set', async () => {
    const mock = stubFetch(200, { groups: [] });
    await new ApiClient({ group: 'camlets' }).operatorGroups();
    expect(lastCall(mock).url).toBe('/api/v1/operator/groups');
  });

  it('routes operator login and group creation', async () => {
    const mock = stubFetch(201, { group: {}, currency: {} });
    const client = new ApiClient({ baseUrl: 'https://silvio.example' });
    await client.operatorLogin('op@x.y', 'pw');
    expect(lastCall(mock).url).toBe('https://silvio.example/api/v1/operator/login');
    await client.operatorCreateGroup({
      slug: 's',
      name: 'n',
      currency: { code: 'CAM', name: 'Cam' },
    });
    expect(lastCall(mock).url).toBe('https://silvio.example/api/v1/operator/groups');
    expect(lastCall(mock).init.method).toBe('POST');
  });
});

describe('error handling', () => {
  it('parses the {error: {code, message}} shape into ApiError', async () => {
    stubFetch(403, { error: { code: 'NOT_AUTHORISED', message: 'admin role required' } });
    const failure = await new ApiClient({ group: 'g1' }).me().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.code).toBe('NOT_AUTHORISED');
    expect(error.message).toBe('admin role required');
    expect(error.status).toBe(403);
  });

  it('falls back to status text when the body is not the error shape', async () => {
    stubFetch(502, 'Bad Gateway HTML', 'Bad Gateway');
    const failure = await new ApiClient().me().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toBe('502 Bad Gateway');
    expect(error.status).toBe(502);
  });

  it('falls back when the body is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 500, statusText: 'Internal Server Error' })),
    );
    const failure = await new ApiClient().pending().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('UNKNOWN');
    expect((failure as ApiError).status).toBe(500);
  });

  it('wraps network failures as ApiError with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const failure = await new ApiClient().me().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
    expect(error.message).toContain('fetch failed');
  });

  it('returns parsed bodies on success', async () => {
    stubFetch(200, { pending: [{ id: 't1', amount: 5, direction: 'in' }] });
    const { pending } = await new ApiClient({ group: 'g1' }).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('t1');
  });

  it('tolerates empty response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(new ApiClient().logout()).resolves.toBeUndefined();
  });
});

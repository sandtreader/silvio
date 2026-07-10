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

  it('routes forgot / reset / verify token flows', async () => {
    const mock = stubFetch(200, { ok: true });
    const client = new ApiClient({ group: 'g1' });
    await client.forgotPassword('a@b.c');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/auth/forgot');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({ email: 'a@b.c' });
    await client.resetPassword('tok-1', 'new password');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/auth/reset');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      token: 'tok-1',
      password: 'new password',
    });
    await client.verifyEmail('tok-2');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/auth/verify');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({ token: 'tok-2' });
  });

  it('builds query strings for statement and flags', async () => {
    const mock = stubFetch(200, { lines: [], total: 0 });
    const client = new ApiClient({ group: 'g1' });
    await client.statement('cur-1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/statement?currencyId=cur-1');
    await client.statement('cur-1', { limit: 50, offset: 100 });
    expect(lastCall(mock).url).toBe(
      '/api/v1/g/g1/me/statement?currencyId=cur-1&limit=50&offset=100',
    );
    expect(client.statementCsvUrl('cur 1')).toBe(
      '/api/v1/g/g1/me/statement.csv?currencyId=cur+1',
    );
    await client.adminFlags('cur 2'); // encoding
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/flags?currencyId=cur+2');
  });

  it('routes the group balances view (#19)', async () => {
    const mock = stubFetch(200, { balances: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.groupBalances('cur 1'); // encoding
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/balances?currencyId=cur+1');
    expect(lastCall(mock).init.method).toBe('GET');
  });

  it('routes the admin dashboard stats query', async () => {
    const mock = stubFetch(200, { balances: [], flow: [], velocity: 0, dormant: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.adminStats('cur 1'); // encoding
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/stats?currencyId=cur+1');
    expect(lastCall(mock).init.method).toBe('GET');
  });

  it('builds listing browse filters, omitting the query when empty', async () => {
    const mock = stubFetch(200, { listings: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.browse();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/listings');
    await client.browse({ type: 'offer', categoryId: 'c9' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/listings?type=offer&categoryId=c9');
  });

  it('builds the search query with domain, q and paging (#18)', async () => {
    const mock = stubFetch(200, { items: [], total: 0 });
    const client = new ApiClient({ group: 'g1' });
    const { items, total } = await client.search('listings', 'veg box');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/search?domain=listings&q=veg+box');
    expect(lastCall(mock).init.method).toBe('GET');
    expect(items).toEqual([]);
    expect(total).toBe(0);
    await client.search('pages', 'market', { limit: 10, offset: 20 });
    expect(lastCall(mock).url).toBe(
      '/api/v1/g/g1/search?domain=pages&q=market&limit=10&offset=20',
    );
  });

  it('renews a listing on the owner route (#18)', async () => {
    const mock = stubFetch(200, { listing: { id: 'l/1' } });
    const { listing } = await new ApiClient({ group: 'g1' }).renewListing('l/1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/listings/l%2F1/renew');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(listing.id).toBe('l/1');
  });

  it('routes signed payment requests: mint, decode, scan (#22)', async () => {
    const mock = stubFetch(201, { payload: 'abc.sig' });
    const client = new ApiClient({ group: 'g1' });
    const { payload } = await client.mintPaymentRequest({
      currencyId: 'cur-1',
      amount: 1500,
      reference: 'veg box',
    });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/payment-requests');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      currencyId: 'cur-1',
      amount: 1500,
      reference: 'veg box',
    });
    expect(payload).toBe('abc.sig');

    await client.decodePaymentRequest('abc.sig+/'); // encoding
    expect(lastCall(mock).url).toBe(
      '/api/v1/g/g1/payment-requests/decode?payload=abc.sig%2B%2F',
    );
    expect(lastCall(mock).init.method).toBe('GET');

    await client.scanPayment('abc.sig'); // fixed amount rides in the payload
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/payments/scan');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      payload: 'abc.sig',
    });
    await client.scanPayment('abc.sig', 250); // open amount from the payer
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      payload: 'abc.sig',
      amount: 250,
    });
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

  it('routes acts-for-member start and stop (#24)', async () => {
    const mock = stubFetch(200, { ok: true });
    const client = new ApiClient({ group: 'g1' });
    await client.actAsMember('m 1'); // encoding
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/members/m%201/act-as');
    expect(lastCall(mock).init.method).toBe('POST');
    await client.stopActing();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/stop-acting');
    expect(lastCall(mock).init.method).toBe('POST');
  });

  it('builds the admin transaction search query, omitting it when empty', async () => {
    const mock = stubFetch(200, { transactions: [], total: 0 });
    const client = new ApiClient({ group: 'g1' });
    await client.adminTransactions();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/transactions');
    expect(lastCall(mock).init.method).toBe('GET');
    await client.adminTransactions({
      q: 'veg box',
      memberId: 'm-1',
      state: 'committed',
      limit: 50,
      offset: 100,
    });
    expect(lastCall(mock).url).toBe(
      '/api/v1/g/g1/admin/transactions?q=veg+box&memberId=m-1&state=committed&limit=50&offset=100',
    );
  });

  it('builds the admin audit query, omitting it when empty', async () => {
    const mock = stubFetch(200, { events: [], total: 0 });
    const client = new ApiClient({ group: 'g1' });
    await client.adminAudit();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/audit');
    expect(lastCall(mock).init.method).toBe('GET');
    await client.adminAudit({
      action: 'member.approve',
      entityType: 'member',
      entityId: 'm-1',
      limit: 50,
      offset: 100,
    });
    expect(lastCall(mock).url).toBe(
      '/api/v1/g/g1/admin/audit?action=member.approve&entityType=member&entityId=m-1&limit=50&offset=100',
    );
  });

  it('encodes path parameters', async () => {
    const mock = stubFetch(200, { member: {}, stats: {} });
    await new ApiClient({ group: 'g1' }).member('id/with?chars');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/members/id%2Fwith%3Fchars');
  });

  it('fetches the public shell info (#15)', async () => {
    const mock = stubFetch(200, {
      group: { name: 'CamLETS', slug: 'cam' },
      branding: {},
      navPages: [],
    });
    const { group } = await new ApiClient({ group: 'cam' }).shellInfo();
    expect(lastCall(mock).url).toBe('/api/v1/g/cam/shell');
    expect(lastCall(mock).init.method).toBe('GET');
    expect(group.slug).toBe('cam');
  });

  it('fetches the public categories and currencies lists', async () => {
    const mock = stubFetch(200, { categories: [], currencies: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.categories();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/categories');
    expect(lastCall(mock).init.method).toBe('GET');
    const { currencies } = await client.currencies();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/currencies');
    expect(lastCall(mock).init.method).toBe('GET');
    expect(currencies).toEqual([]);
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
    await client.adminRuns();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/runs');
    expect(lastCall(mock).init.method).toBe('GET');
    await client.adminUnrestrict('m-1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/restrictions/m-1');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('routes admin images: list, raw-body upload, delete (decision #14)', async () => {
    const mock = stubFetch(200, { images: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.adminImages();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/images');
    expect(lastCall(mock).init.method).toBe('GET');

    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    await client.adminUploadImage(blob, 'image/jpeg');
    const { url, init } = lastCall(mock);
    expect(url).toBe('/api/v1/g/g1/admin/images');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(init.body).toBe(blob); // raw body, never JSON-stringified
    expect(init.credentials).toBe('include');

    await client.adminDeleteImage('img/1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/images/img%2F1');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('routes branding: brand-filtered list, raw-body upload, delete (#15)', async () => {
    const mock = stubFetch(200, { images: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.adminBrandImages();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/images?ownerKind=brand');
    expect(lastCall(mock).init.method).toBe('GET');

    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    await client.setBrandImage('logo', blob, 'image/jpeg');
    const { url, init } = lastCall(mock);
    expect(url).toBe('/api/v1/g/g1/admin/branding/logo');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(init.body).toBe(blob); // raw body, never JSON-stringified

    await client.deleteBrandImage('header');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/branding/header');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('routes the profile photo: raw-body upload and delete (decision #14)', async () => {
    const mock = stubFetch(201, { image: {} });
    const client = new ApiClient({ group: 'g1' });

    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    await client.setMyPhoto(blob, 'image/jpeg');
    const { url, init } = lastCall(mock);
    expect(url).toBe('/api/v1/g/g1/me/photo');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(init.body).toBe(blob); // raw body, never JSON-stringified
    expect(init.credentials).toBe('include');

    await client.deleteMyPhoto();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/photo');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('routes listing photos: raw-body upload and delete (decision #14)', async () => {
    const mock = stubFetch(201, { image: {} });
    const client = new ApiClient({ group: 'g1' });

    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    await client.addListingPhoto('l/1', blob, 'image/jpeg');
    const { url, init } = lastCall(mock);
    expect(url).toBe('/api/v1/g/g1/listings/l%2F1/photos');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(init.body).toBe(blob); // raw body, never JSON-stringified
    expect(init.credentials).toBe('include');

    await client.removeListingPhoto('l/1', 'img/9');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/listings/l%2F1/photos/img%2F9');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('routes email templates: list, override, revert (#16)', async () => {
    const mock = stubFetch(200, { templates: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.adminEmailTemplates();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/email-templates');
    expect(lastCall(mock).init.method).toBe('GET');

    await client.putEmailTemplate('welcome', { subject: 'Hi {{memberName}}', body: 'b' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/email-templates/welcome');
    expect(lastCall(mock).init.method).toBe('PUT');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      subject: 'Hi {{memberName}}',
      body: 'b',
    });

    await client.deleteEmailTemplate('payment_held');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/email-templates/payment_held');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('routes the admin group read and sender patch (#16)', async () => {
    const mock = stubFetch(200, { group: {} });
    const client = new ApiClient({ group: 'g1' });
    await client.adminGroup();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/group');
    expect(lastCall(mock).init.method).toBe('GET');

    await client.patchAdminGroup({ emailFrom: 'lets@example.org' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/group');
    expect(lastCall(mock).init.method).toBe('PATCH');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      emailFrom: 'lets@example.org',
    });

    await client.patchAdminGroup({ emailFrom: null }); // clear → instance default
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({ emailFrom: null });

    // Settings replace the whole object; name rides the same PATCH.
    await client.patchAdminGroup({
      name: 'CamLETS',
      settings: { autoAcceptDays: 7, digestDefault: 'monthly' },
    });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/group');
    expect(lastCall(mock).init.method).toBe('PATCH');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      name: 'CamLETS',
      settings: { autoAcceptDays: 7, digestDefault: 'monthly' },
    });
  });

  it('patches the digest frequency on /me (#17)', async () => {
    const mock = stubFetch(200, { member: {} });
    await new ApiClient({ group: 'g1' }).updateMe({ digestFrequency: 'monthly' });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me');
    expect(lastCall(mock).init.method).toBe('PATCH');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      digestFrequency: 'monthly',
    });
  });

  it('posts the admin broadcast and returns the queued count (#17)', async () => {
    const mock = stubFetch(200, { ok: true, queued: 12 });
    const { queued } = await new ApiClient({ group: 'g1' }).adminBroadcast(
      'Summer fair',
      'See you *there*.',
    );
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/broadcast');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      subject: 'Summer fair',
      body: 'See you *there*.',
    });
    expect(queued).toBe(12);
  });

  it('lists active restrictions on the admin route', async () => {
    const mock = stubFetch(200, { restrictions: [] });
    const client = new ApiClient({ group: 'g1' });
    const { restrictions } = await client.adminRestrictions();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/admin/restrictions');
    expect(lastCall(mock).init.method).toBe('GET');
    expect(restrictions).toEqual([]);
  });

  it('keeps operator routes outside any tenant, even with a group set', async () => {
    const mock = stubFetch(200, { groups: [] });
    await new ApiClient({ group: 'camlets' }).operatorGroups();
    expect(lastCall(mock).url).toBe('/api/v1/operator/groups');
  });

  it('routes operator login and group provisioning', async () => {
    const mock = stubFetch(201, { group: {}, currency: {} });
    const client = new ApiClient({ baseUrl: 'https://silvio.example' });
    await client.operatorLogin('op@x.y', 'pw');
    expect(lastCall(mock).url).toBe('https://silvio.example/api/v1/operator/login');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      email: 'op@x.y',
      password: 'pw',
    });
    await client.provisionGroup({
      slug: 's',
      name: 'n',
      currency: { code: 'CAM', name: 'Cam' },
    });
    expect(lastCall(mock).url).toBe('https://silvio.example/api/v1/operator/groups');
    expect(lastCall(mock).init.method).toBe('POST');
  });

  it('patches an operator group, passing nullable plan/notes through', async () => {
    const mock = stubFetch(200, { group: { id: 'g-1', status: 'suspended' } });
    const { group } = await new ApiClient().patchOperatorGroup('g-1', {
      status: 'suspended',
      plan: null,
      notes: 'paused pending renewal',
    });
    expect(lastCall(mock).url).toBe('/api/v1/operator/groups/g-1');
    expect(lastCall(mock).init.method).toBe('PATCH');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      status: 'suspended',
      plan: null,
      notes: 'paused pending renewal',
    });
    expect(group.status).toBe('suspended');
  });

  it('adds and removes group domains, encoding the hostname', async () => {
    const mock = stubFetch(200, { ok: true });
    const client = new ApiClient();
    await client.addGroupDomain('g-1', 'lets.example.org');
    expect(lastCall(mock).url).toBe('/api/v1/operator/groups/g-1/domains');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      hostname: 'lets.example.org',
    });
    await client.removeGroupDomain('g-1', 'lets.example.org');
    expect(lastCall(mock).url).toBe(
      '/api/v1/operator/groups/g-1/domains/lets.example.org',
    );
    expect(lastCall(mock).init.method).toBe('DELETE');
  });
});

describe('API token routes (decision #9)', () => {
  it('lists my tokens', async () => {
    const mock = stubFetch(200, { tokens: [{ id: 'tok-1', label: 'agent' }] });
    const { tokens } = await new ApiClient({ group: 'g1' }).myTokens();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/tokens');
    expect(lastCall(mock).init.method).toBe('GET');
    expect(tokens[0]?.id).toBe('tok-1');
  });

  it('creates a token, passing caps and expiry through', async () => {
    const mock = stubFetch(201, { token: 'slv_raw', apiToken: { id: 'tok-1' } });
    const { token, apiToken } = await new ApiClient({ group: 'g1' }).createToken({
      label: 'My agent',
      scopes: ['account:read', 'trade:autonomous'],
      maxTxAmount: 500,
      maxPeriodAmount: 2000,
      periodDays: 30,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/tokens');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      label: 'My agent',
      scopes: ['account:read', 'trade:autonomous'],
      maxTxAmount: 500,
      maxPeriodAmount: 2000,
      periodDays: 30,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(token).toBe('slv_raw');
    expect(apiToken.id).toBe('tok-1');
  });

  it('revokes a token by id, encoding it', async () => {
    const mock = stubFetch(200, { ok: true });
    const { ok } = await new ApiClient({ group: 'g1' }).revokeToken('tok/1');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/tokens/tok%2F1');
    expect(lastCall(mock).init.method).toBe('DELETE');
    expect(ok).toBe(true);
  });
});

describe('joint membership routes (decision #23)', () => {
  it('lists, adds and removes household persons', async () => {
    const mock = stubFetch(200, { persons: [] });
    const client = new ApiClient({ group: 'g1' });
    await client.myPersons();
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/persons');
    expect(lastCall(mock).init.method).toBe('GET');

    await client.addPerson('Bob', 'bob@x.y');
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/persons');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      name: 'Bob',
      email: 'bob@x.y',
    });

    await client.removePerson('p/1'); // encoding
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/me/persons/p%2F1');
    expect(lastCall(mock).init.method).toBe('DELETE');
  });

  it('accepts an invite with token and password', async () => {
    const mock = stubFetch(200, { ok: true });
    const { ok } = await new ApiClient({ group: 'g1' }).acceptInvite(
      'tok-1',
      'new password',
    );
    expect(lastCall(mock).url).toBe('/api/v1/g/g1/auth/accept-invite');
    expect(lastCall(mock).init.method).toBe('POST');
    expect(JSON.parse(lastCall(mock).init.body as string)).toEqual({
      token: 'tok-1',
      password: 'new password',
    });
    expect(ok).toBe(true);
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

// Audit trail over the API (data-model §8): admin actions, MCP token
// grants/revocations and lifecycle transitions land in the append-only
// audit_events log, surfaced to admins at GET /admin/audit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { AuditEvent, Group, Member } from '../../src/types.js';

describe('audit trail (§8)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let alice: Member; // admin
  let bob: Member;
  let adminCookie: string;
  let memberCookie: string;

  async function makeMember(name: string): Promise<Member> {
    const email = `${name.toLowerCase()}@example.com`;
    const user = await register(storage, { email, password: `password-${name}` });
    const applied = await apply(storage, {
      groupId: group.id, displayName: name, personName: name, email, userId: user.id,
    });
    return approve(storage, applied.member.id);
  }

  async function cookieFor(name: string): Promise<string> {
    const { token } = await login(storage, {
      email: `${name.toLowerCase()}@example.com`,
      password: `password-${name}`,
      groupId: group.id,
    });
    return `silvio_session=${token}`;
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    bob = await makeMember('Bob');
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function admin(method: string, url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method: method as 'POST',
      url: `/api/v1/g/cam${url}`,
      headers: { cookie: adminCookie, origin: 'http://localhost' },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function eventsFor(action: string): Promise<AuditEvent[]> {
    const { events } = await storage.listAuditEvents(group.id, { action });
    return events;
  }

  it('admin member-lifecycle actions are audited with the acting user', async () => {
    const res = await admin('POST', `/admin/members/${bob.id}/suspend`);
    expect(res.statusCode).toBe(200);
    const [event] = await eventsFor('member.suspend');
    expect(event).toMatchObject({ entityType: 'member', entityId: bob.id });
    expect(event!.actorUserId).toBeTruthy();

    await admin('POST', `/admin/members/${bob.id}/reinstate`);
    expect(await eventsFor('member.reinstate')).toHaveLength(1);
  });

  it('role changes carry the new role in detail', async () => {
    await admin('POST', `/admin/members/${bob.id}/role`, { role: 'committee' });
    const [event] = await eventsFor('member.role');
    expect(event!.detail).toMatchObject({ role: 'committee' });
  });

  it('restrictions impose/lift are audited', async () => {
    await admin('POST', '/admin/restrictions', { memberId: bob.id, reason: 'overdrawn' });
    const [imposed] = await eventsFor('restriction.impose');
    expect(imposed).toMatchObject({ entityType: 'member', entityId: bob.id });
    expect(imposed!.detail).toMatchObject({ reason: 'overdrawn' });

    await admin('DELETE', `/admin/restrictions/${bob.id}`);
    expect(await eventsFor('restriction.lift')).toHaveLength(1);
  });

  it('API token grant and revocation are audited (MCP grants, §8)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/tokens',
      headers: { cookie: memberCookie, origin: 'http://localhost' },
      payload: { label: 'my agent', scopes: ['marketplace:read'] },
    });
    expect(created.statusCode).toBe(201);
    const { apiToken } = created.json() as { apiToken: { id: string } };
    const [granted] = await eventsFor('token.issue');
    expect(granted).toMatchObject({ entityType: 'api_token', entityId: apiToken.id });
    expect(granted!.detail).toMatchObject({ label: 'my agent', scopes: ['marketplace:read'] });

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/me/tokens/${apiToken.id}`,
      headers: { cookie: memberCookie, origin: 'http://localhost' },
    });
    expect(await eventsFor('token.revoke')).toHaveLength(1);
  });

  it('membership applications are audited as lifecycle transitions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/applications',
      headers: { origin: 'http://localhost' },
      payload: {
        displayName: 'Carol', personName: 'Carol',
        email: 'carol@example.com', password: 'password-carol',
      },
    });
    const [event] = await eventsFor('member.apply');
    expect(event!.entityType).toBe('member');
  });

  it('admin approval is audited', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/applications',
      headers: { origin: 'http://localhost' },
      payload: {
        displayName: 'Dave', personName: 'Dave',
        email: 'dave@example.com', password: 'password-dave',
      },
    });
    const applied = (await storage.listMembers(group.id, 'applied'))[0]!;
    await admin('POST', `/admin/members/${applied.id}/approve`);
    const [event] = await eventsFor('member.approve');
    expect(event!.entityId).toBe(applied.id);
  });

  it('content changes are audited', async () => {
    await admin('POST', '/admin/pages', {
      slug: 'about', title: 'About', body: 'x', visibility: 'public',
    });
    const [event] = await eventsFor('page.create');
    expect(event!.detail).toMatchObject({ slug: 'about' });

    await admin('POST', '/admin/broadcast', { subject: 'AGM', body: 'x' });
    const [broadcast] = await eventsFor('broadcast.send');
    expect(broadcast!.detail).toMatchObject({ subject: 'AGM' });
  });

  describe('GET /admin/audit', () => {
    it('is admin-only and pages newest first with a total', async () => {
      await admin('POST', `/admin/members/${bob.id}/suspend`);
      await admin('POST', `/admin/members/${bob.id}/reinstate`);
      await admin('POST', `/admin/members/${bob.id}/role`, { role: 'committee' });

      const forbidden = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/admin/audit', headers: { cookie: memberCookie },
      });
      expect(forbidden.statusCode).toBe(403);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/g/cam/admin/audit?limit=2',
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      const { events, total } = res.json() as { events: AuditEvent[]; total: number };
      expect(total).toBeGreaterThanOrEqual(3);
      expect(events).toHaveLength(2);
      expect(events[0]!.action).toBe('member.role'); // newest first

      const filtered = await app.inject({
        method: 'GET',
        url: '/api/v1/g/cam/admin/audit?action=member.suspend',
        headers: { cookie: adminCookie },
      });
      const body = filtered.json() as { events: AuditEvent[]; total: number };
      expect(body.total).toBe(1);
      expect(body.events[0]!.entityId).toBe(bob.id);
    });

    // The log shows people what happened without pasting UUIDs around:
    // events carry the actor's member name and a human entity label,
    // resolved best-effort at read time (absent when the entity is gone).
    it('labels events with actor and entity names', async () => {
      await admin('POST', `/admin/members/${bob.id}/suspend`);
      await admin('POST', '/admin/pages', {
        slug: 'about', title: 'About us', body: 'Hello', visibility: 'public',
      });

      type Labelled = AuditEvent & { actorName?: string; entityLabel?: string };
      const res = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/admin/audit',
        headers: { cookie: adminCookie },
      });
      const { events } = res.json() as { events: Labelled[] };

      const suspend = events.find((e) => e.action === 'member.suspend')!;
      expect(suspend.actorName).toBe('Alice');
      expect(suspend.entityLabel).toBe('Bob');

      const page = events.find((e) => e.entityType === 'page')!;
      expect(page.actorName).toBe('Alice');
      expect(page.entityLabel).toBe('About us');
    });

    it('omits the entity label once the entity is gone', async () => {
      const created = await admin('POST', '/admin/pages', {
        slug: 'temp', title: 'Temporary', body: 'x', visibility: 'public',
      });
      const pageId = (created.json() as { page: { id: string } }).page.id;
      await admin('DELETE', `/admin/pages/${pageId}`);

      type Labelled = AuditEvent & { actorName?: string; entityLabel?: string };
      const res = await app.inject({
        method: 'GET', url: `/api/v1/g/cam/admin/audit?entityId=${pageId}`,
        headers: { cookie: adminCookie },
      });
      const { events } = res.json() as { events: Labelled[] };
      expect(events.length).toBeGreaterThanOrEqual(2); // create + delete
      for (const event of events) {
        expect(event).not.toHaveProperty('entityLabel');
        expect(event.actorName).toBe('Alice'); // actor still resolves
      }
    });
  });
});

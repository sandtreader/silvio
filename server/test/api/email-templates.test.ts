// Admin email template routes (#16): the effective template per kind (an
// override or the built-in default), PUT to override, DELETE to revert —
// plus the group sender address on GET/PATCH /admin/group.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KINDS,
} from '../../src/services/emailtemplates.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

interface TemplateView {
  kind: string;
  subject: string;
  body: string;
  isDefault: boolean;
}

describe('admin email templates API (#16)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
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
    const alice = await makeMember('Alice');
    await storage.updateMember(alice.id, { role: 'admin' });
    await makeMember('Bob');
    app = await buildApp(storage);
    await app.ready();
    adminCookie = await cookieFor('Alice');
    memberCookie = await cookieFor('Bob');
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function list(cookie = adminCookie) {
    return app.inject({
      method: 'GET', url: '/api/v1/g/cam/admin/email-templates', headers: { cookie },
    });
  }

  function put(kind: string, payload: Record<string, unknown>, cookie = adminCookie) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/g/cam/admin/email-templates/${kind}`,
      headers: { cookie, origin: 'http://localhost' },
      payload,
    });
  }

  it('lists every kind with its effective template, defaults flagged', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    const { templates } = res.json() as { templates: TemplateView[] };
    expect(templates.map((t) => t.kind)).toEqual([...EMAIL_TEMPLATE_KINDS]);
    for (const template of templates) {
      expect(template.isDefault).toBe(true);
      expect(template.subject).toBe(
        DEFAULT_EMAIL_TEMPLATES[template.kind as keyof typeof DEFAULT_EMAIL_TEMPLATES].subject,
      );
    }
  });

  it('PUT overrides a kind; DELETE reverts it', async () => {
    const res = await put('welcome', { subject: 'Custom hi', body: 'Custom body' });
    expect(res.statusCode).toBe(200);

    let { templates } = (await list()).json() as { templates: TemplateView[] };
    const welcome = templates.find((t) => t.kind === 'welcome');
    expect(welcome).toMatchObject({ subject: 'Custom hi', body: 'Custom body', isDefault: false });

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/g/cam/admin/email-templates/welcome',
      headers: { cookie: adminCookie, origin: 'http://localhost' },
    });
    expect(del.statusCode).toBe(200);
    ({ templates } = (await list()).json() as { templates: TemplateView[] });
    expect(templates.find((t) => t.kind === 'welcome')).toMatchObject({
      subject: DEFAULT_EMAIL_TEMPLATES.welcome.subject,
      isDefault: true,
    });
  });

  it('rejects an unknown kind', async () => {
    expect((await put('ransom_note', { subject: 's', body: 'b' })).statusCode).toBe(400);
  });

  it('is admin-only', async () => {
    expect((await list(memberCookie)).statusCode).toBe(403);
    expect((await put('welcome', { subject: 's', body: 'b' }, memberCookie)).statusCode)
      .toBe(403);
  });

  describe('group sender address (#16)', () => {
    it('PATCH /admin/group sets emailFrom; GET reads it back; null clears', async () => {
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/v1/g/cam/admin/group',
        headers: { cookie: adminCookie, origin: 'http://localhost' },
        payload: { emailFrom: 'lets@cam.example.org' },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { group: Group }).group.emailFrom).toBe('lets@cam.example.org');

      const got = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/admin/group', headers: { cookie: adminCookie },
      });
      expect((got.json() as { group: Group }).group.emailFrom).toBe('lets@cam.example.org');

      const clear = await app.inject({
        method: 'PATCH',
        url: '/api/v1/g/cam/admin/group',
        headers: { cookie: adminCookie, origin: 'http://localhost' },
        payload: { emailFrom: null },
      });
      expect((clear.json() as { group: Group }).group.emailFrom).toBeUndefined();
    });

    it('is admin-only', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/g/cam/admin/group', headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

// GET /shell (#15): the public, session-aware endpoint the member app's
// client-rendered chrome is built from — group identity, branding image
// ids, the viewer's visible nav pages, and who is logged in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { setBrandImage } from '../../src/services/images.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(size = 100): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(size - PNG_MAGIC.length, 7)]);
}

interface ShellInfo {
  group: { name: string; slug: string };
  branding: { logoImageId?: string; headerImageId?: string };
  navPages: { slug: string; title: string }[];
  member?: { displayName: string };
}

describe('GET /shell (#15)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let bob: Member;
  let bobCookie: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const user = await register(storage, { email: 'bob@example.com', password: 'password-1' });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'Bob',
      email: 'bob@example.com', userId: user.id,
    });
    bob = await approve(storage, applied.member.id);
    await storage.createPage({
      groupId: group.id, slug: 'about', title: 'About us', body: 'x', visibility: 'public',
    });
    await storage.createPage({
      groupId: group.id, slug: 'handbook', title: 'Handbook', body: 'x', visibility: 'members',
    });
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'bob@example.com', password: 'password-1', groupId: group.id,
    });
    bobCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function shell(cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers['cookie'] = cookie;
    return app.inject({ method: 'GET', url: '/api/v1/g/cam/shell', headers });
  }

  it('logged out: group identity and public nav only, no member', async () => {
    const res = await shell();
    expect(res.statusCode).toBe(200);
    const info = res.json() as ShellInfo;
    expect(info.group).toEqual({ name: 'CamLETS', slug: 'cam' });
    expect(info.branding).toEqual({});
    expect(info.navPages).toEqual([{ slug: 'about', title: 'About us' }]);
    expect(info.member).toBeUndefined();
  });

  it('logged in: members-visibility pages appear and the member is named', async () => {
    const res = await shell(bobCookie);
    const info = res.json() as ShellInfo;
    expect(info.navPages.map((p) => p.slug)).toEqual(['about', 'handbook']);
    expect(info.member).toEqual({ displayName: 'Bob' });
  });

  it('carries the branding image ids when set', async () => {
    const logo = await setBrandImage(storage, group.id, 'logo', 'image/png', png(), bob.id);
    const res = await shell();
    const info = res.json() as ShellInfo;
    expect(info.branding).toEqual({ logoImageId: logo.id });
  });

  it('404s for an unknown group', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/g/nope/shell' });
    expect(res.statusCode).toBe(404);
  });
});

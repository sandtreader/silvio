// Brochure site & app shell (decision #12): the group's root is a
// server-rendered public brochure (placeholder content until the CMS lands),
// the member app is served under /app/ inside the same shell chrome, and
// tenancy comes from the Host header exactly as for the API.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { postListing } from '../../src/services/marketplace.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member } from '../../src/types.js';

const HOST = 'cam.example.org';

describe('brochure site & app shell (#12)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let alice: Member;
  let distRoot: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, HOST);
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const user = await register(storage, { email: 'alice@example.com', password: 'password-1' });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice',
      email: 'alice@example.com', userId: user.id,
    });
    alice = await approve(storage, applied.member.id);

    // Fake built UIs: enough structure for static serving + shell injection.
    distRoot = mkdtempSync(join(tmpdir(), 'silvio-brochure-'));
    const memberDist = join(distRoot, 'member');
    const adminDist = join(distRoot, 'admin');
    mkdirSync(join(memberDist, 'assets'), { recursive: true });
    mkdirSync(adminDist, { recursive: true });
    writeFileSync(
      join(memberDist, 'index.html'),
      '<!doctype html>\n<html><head><title>Silvio</title></head>'
        + '<body><div id="root"></div><script src="/app/assets/main.js"></script></body></html>\n',
    );
    writeFileSync(join(memberDist, 'assets', 'main.js'), 'console.log("app")\n');
    writeFileSync(
      join(adminDist, 'index.html'),
      '<!doctype html><html><body><div id="admin-root"></div></body></html>\n',
    );

    app = await buildApp(storage, { ui: { memberDist, adminDist } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    storage.close();
    rmSync(distRoot, { recursive: true, force: true });
  });

  async function sessionCookie(): Promise<string> {
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'password-1', groupId: group.id,
    });
    return `silvio_session=${token}`;
  }

  describe('brochure pages', () => {
    it('GET / renders the group brochure with a link into the app', async () => {
      const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('CamLETS');
      expect(res.body).toContain('/app');
    });

    it('GET / is session-aware: a logged-in member sees their name', async () => {
      const cookie = await sessionCookie();
      const res = await app.inject({
        method: 'GET', url: '/', headers: { host: HOST, cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Alice');
    });

    it('GET /market lists active listings publicly, HTML-escaped', async () => {
      const category = await storage.createCategory({ groupId: group.id, name: 'Food' });
      await postListing(storage, alice.id, {
        type: 'offer', categoryId: category.id,
        title: 'Veg <script>alert(1)</script> box', description: 'Weekly & organic',
      });
      const res = await app.inject({ method: 'GET', url: '/market', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).not.toContain('<script>alert(1)</script>');
      expect(res.body).toContain('Veg &lt;script&gt;alert(1)&lt;/script&gt; box');
      expect(res.body).toContain('Weekly &amp; organic');
    });

    it('an unknown host gets a 404 page, not a brochure', async () => {
      const res = await app.inject({
        method: 'GET', url: '/', headers: { host: 'nowhere.example.org' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('CMS pages on the brochure (#13)', () => {
    beforeEach(async () => {
      await storage.createPage({
        groupId: group.id, slug: 'agreement', title: 'Our Agreement',
        body: '# The Agreement\n\nBe *excellent*.\n\n<script>alert(1)</script>',
        visibility: 'public', position: 1,
      });
      await storage.createPage({
        groupId: group.id, slug: 'notices', title: 'Member Notices',
        body: 'Members only.', visibility: 'members', position: 2,
      });
      await storage.createPage({
        groupId: group.id, slug: 'crisis', title: 'Crisis Notes',
        body: 'Admin eyes only.', visibility: 'admin', position: 3,
      });
    });

    it('GET /p/{slug} renders the markdown body in the shell', async () => {
      const res = await app.inject({
        method: 'GET', url: '/p/agreement', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<h1>The Agreement</h1>');
      expect(res.body).toContain('<em>excellent</em>');
      // Raw HTML in the markdown source stays escaped, end to end.
      expect(res.body).not.toContain('<script>alert(1)</script>');
    });

    it('unknown slugs 404', async () => {
      const res = await app.inject({
        method: 'GET', url: '/p/missing', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(404);
    });

    it('members-visibility pages need a session; admin pages need an admin', async () => {
      expect(
        (await app.inject({ method: 'GET', url: '/p/notices', headers: { host: HOST } }))
          .statusCode,
      ).toBe(404);
      const cookie = await sessionCookie();
      expect(
        (await app.inject({
          method: 'GET', url: '/p/notices', headers: { host: HOST, cookie },
        })).statusCode,
      ).toBe(200);
      // Alice is not an admin: the admin page hides from her too.
      expect(
        (await app.inject({
          method: 'GET', url: '/p/crisis', headers: { host: HOST, cookie },
        })).statusCode,
      ).toBe(404);
      await storage.updateMember(alice.id, { role: 'admin' });
      expect(
        (await app.inject({
          method: 'GET', url: '/p/crisis', headers: { host: HOST, cookie },
        })).statusCode,
      ).toBe(200);
    });

    it('the shell nav lists pages the viewer may see, by position', async () => {
      const anon = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
      expect(anon.body).toContain('Our Agreement');
      expect(anon.body).not.toContain('Member Notices');
      expect(anon.body).not.toContain('Crisis Notes');

      const cookie = await sessionCookie();
      const authed = await app.inject({
        method: 'GET', url: '/', headers: { host: HOST, cookie },
      });
      expect(authed.body).toContain('Our Agreement');
      expect(authed.body).toContain('Member Notices');
      expect(authed.body).not.toContain('Crisis Notes');
    });

    it('a page with slug "home" replaces the placeholder at / (and is not in the nav)', async () => {
      await storage.createPage({
        groupId: group.id, slug: 'home', title: 'Home',
        body: '# Hello CamLETS\n\nOur own front page.', visibility: 'public',
      });
      const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<h1>Hello CamLETS</h1>');
      expect(res.body).toContain('Our own front page.');
      // The built-in placeholder copy is gone...
      expect(res.body).not.toContain('local exchange trading system');
      // ...and 'home' is served at the root, not listed alongside other pages.
      const navCount = (res.body.match(/href="\/p\/home"/g) ?? []).length;
      expect(navCount).toBe(0);
    });
  });

  describe('news on the brochure (#13)', () => {
    beforeEach(async () => {
      await storage.createNewsItem({
        groupId: group.id, title: 'Market <b>day</b>', body: 'See you *Saturday*.',
        publishedAt: '2026-07-01T00:00:00.000Z',
      });
      await storage.createNewsItem({
        groupId: group.id, title: 'Bygones', body: 'Expired.',
        publishedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z',
      });
      await storage.createNewsItem({
        groupId: group.id, title: 'Someday', body: 'Scheduled.',
        publishedAt: '2100-01-01T00:00:00.000Z',
      });
    });

    it('GET /news renders current items only, markdown-rendered and escaped', async () => {
      const res = await app.inject({ method: 'GET', url: '/news', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<em>Saturday</em>');
      // Titles are user content: escaped, never raw.
      expect(res.body).toContain('Market &lt;b&gt;day&lt;/b&gt;');
      expect(res.body).not.toContain('Market <b>day</b>');
      expect(res.body).not.toContain('Bygones');
      expect(res.body).not.toContain('Someday');
    });

    it('the shell nav links to /news', async () => {
      const res = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
      expect(res.body).toContain('href="/news"');
    });
  });

  describe('app under /app/ in the shell', () => {
    it('GET /app/ serves the app wrapped in shell chrome', async () => {
      const res = await app.inject({ method: 'GET', url: '/app/', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // The app mount point and bundle survive...
      expect(res.body).toContain('id="root"');
      expect(res.body).toContain('/app/assets/main.js');
      // ...wrapped in shell chrome carrying the group skin, injected before
      // the mount point, hidden when running as an installed PWA.
      expect(res.body).toContain('CamLETS');
      expect(res.body.indexOf('CamLETS')).toBeLessThan(res.body.indexOf('id="root"'));
      expect(res.body).toContain('display-mode: standalone');
    });

    it('deep links into the app get the same shell (SPA fallback)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/app/activity', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('id="root"');
      expect(res.body).toContain('CamLETS');
    });

    it('app assets are served untouched', async () => {
      const res = await app.inject({
        method: 'GET', url: '/app/assets/main.js', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('console.log');
    });

    it('the admin SPA fallback still works', async () => {
      const res = await app.inject({
        method: 'GET', url: '/admin/members', headers: { host: HOST },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('admin-root');
    });
  });
});

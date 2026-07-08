// Same-origin UI serving (decision #11): member app at /, admin at /admin/,
// SPA fallback for client-side routes, API untouched at /api/v1.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';

describe('static UI serving', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'silvio-static-'));
    const memberDist = join(dir, 'member');
    const adminDist = join(dir, 'admin');
    mkdirSync(memberDist);
    mkdirSync(adminDist);
    writeFileSync(join(memberDist, 'index.html'), '<html>MEMBER-APP</html>');
    writeFileSync(join(memberDist, 'app.js'), 'member-js');
    writeFileSync(join(adminDist, 'index.html'), '<html>ADMIN-APP</html>');

    storage = new SqliteStorage(':memory:');
    const group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, 'cam.example.org');
    app = await buildApp(storage, { ui: { memberDist, adminDist } });
  });

  afterEach(async () => {
    await app.close();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the member app at / and its assets', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('MEMBER-APP');
    const asset = await app.inject({ method: 'GET', url: '/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('member-js');
  });

  it('SPA fallback: client-side member routes serve the member index', async () => {
    for (const url of ['/market', '/activity', '/pay']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('MEMBER-APP');
    }
  });

  it('serves the admin app under /admin/ with its own SPA fallback', async () => {
    const index = await app.inject({ method: 'GET', url: '/admin/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('ADMIN-APP');
    const deep = await app.inject({ method: 'GET', url: '/admin/members' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('ADMIN-APP');
  });

  it('API routes are unaffected, and unknown API paths stay JSON 404s', async () => {
    const api = await app.inject({
      method: 'GET', url: '/api/v1/listings', headers: { host: 'cam.example.org' },
    });
    expect(api.statusCode).toBe(200);
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/no-such-route' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
  });

  it('without ui dists configured the app behaves as before', async () => {
    const bare = await buildApp(storage);
    const res = await bare.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});

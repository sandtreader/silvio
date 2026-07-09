// Group currencies endpoint (todo: API polish). Like /categories, the
// currency list is public group metadata: codes and scales are needed to
// render prices on the public marketplace, and the admin UI needs the full
// list rather than just the currencies the admin holds accounts in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, Group } from '../../src/types.js';

describe('GET /currencies', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2, demurrageDay: 1,
    });
    await storage.createCurrency({ groupId: group.id, code: 'HRS', name: 'Hours' });
    const other = await storage.createGroup({ slug: 'fal', name: 'Falmouth' });
    await storage.createCurrency({ groupId: other.id, code: 'FAL', name: 'Fals' });
    app = await buildApp(storage);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  it('lists the group currencies without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/g/cam/currencies' });
    expect(res.statusCode).toBe(200);
    const { currencies } = res.json() as { currencies: Currency[] };
    expect(currencies.map((c) => c.code).sort()).toEqual(['CAM', 'HRS']);
    const cam = currencies.find((c) => c.code === 'CAM')!;
    expect(cam.id).toBe(cams.id);
    expect(cam.name).toBe('Cams');
    expect(cam.scale).toBe(2);
    expect(cam.demurrageDay).toBe(1);
  });

  it('never includes another group\'s currencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/g/fal/currencies' });
    expect(res.statusCode).toBe(200);
    const { currencies } = res.json() as { currencies: Currency[] };
    expect(currencies.map((c) => c.code)).toEqual(['FAL']);
  });

  it('404s for an unknown group', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/g/nope/currencies' });
    expect(res.statusCode).toBe(404);
  });
});

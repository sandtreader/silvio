// Password reset & email verification over the API (data-model §1): forgot
// never discloses account existence and is throttled against mail-bombing;
// reset and verify consume single-use tokens minted into emailed links.
// Applying for membership sends the verification email.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { EmailEvent, Group } from '../../src/types.js';

describe('password reset & email verification API (§1)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    await storage.addGroupDomain(group.id, 'cam.example.org');
    const cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    app = await buildApp(storage);
    await app.ready();
    // An applicant with an account (applications register + apply).
    await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/applications',
      headers: { origin: 'http://localhost' },
      payload: {
        displayName: 'Alice', personName: 'Alice',
        email: 'alice@example.com', password: 'password-alice',
      },
    });
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  async function eventsOfKind(kind: string): Promise<EmailEvent[]> {
    return (await storage.pendingEmails(100)).filter((e) => e.kind === kind);
  }

  function tokenFrom(event: EmailEvent): string {
    return event.body.match(/[?&]token=([0-9a-f]+)/)![1]!;
  }

  function forgot(email: string, ip = '10.0.0.1') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/forgot',
      headers: { origin: 'http://localhost', host: 'cam.example.org' },
      remoteAddress: ip,
      payload: { email },
    });
  }

  it('applying sends a verification email built from the request host', async () => {
    const [event] = await eventsOfKind('email_verify');
    expect(event).toBeDefined();
    expect(event!.toEmail).toBe('alice@example.com');
    expect(event!.body).toContain('http://localhost/app/verify?token=');
  });

  it('POST /auth/verify consumes the token and stamps the user', async () => {
    const [event] = await eventsOfKind('email_verify');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/verify',
      headers: { origin: 'http://localhost' },
      payload: { token: tokenFrom(event!) },
    });
    expect(res.statusCode).toBe(200);
    const creds = await storage.credentialsForEmail('alice@example.com');
    expect(creds!.user.emailVerifiedAt).toBeTruthy();

    // Single use.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/verify',
      headers: { origin: 'http://localhost' },
      payload: { token: tokenFrom(event!) },
    });
    expect(again.statusCode).toBe(400);
  });

  it('forgot answers 200 for known and unknown emails alike', async () => {
    expect((await forgot('alice@example.com')).statusCode).toBe(200);
    expect((await forgot('stranger@example.com')).statusCode).toBe(200);
    const events = await eventsOfKind('password_reset');
    expect(events).toHaveLength(1);
    expect(events[0]!.toEmail).toBe('alice@example.com');
    // The link points at this group's own host.
    expect(events[0]!.body).toContain('http://cam.example.org/app/reset?token=');
  });

  it('the emailed token resets the password via POST /auth/reset', async () => {
    await forgot('alice@example.com');
    const [event] = await eventsOfKind('password_reset');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/reset',
      headers: { origin: 'http://localhost' },
      payload: { token: tokenFrom(event!), password: 'password-new' },
    });
    expect(res.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/login',
      headers: { origin: 'http://localhost' },
      payload: { email: 'alice@example.com', password: 'password-new' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('a garbage token is a 400, not an oracle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/reset',
      headers: { origin: 'http://localhost' },
      payload: { token: 'deadbeef', password: 'password-new' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forgot is throttled per email', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await forgot('alice@example.com')).statusCode).toBe(200);
    }
    const throttled = await forgot('alice@example.com');
    expect(throttled.statusCode).toBe(429);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  }, 30_000);
});

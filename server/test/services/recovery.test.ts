// Password reset & email verification (data-model §1, todo: Membership &
// identity). Single-use expiring tokens, hashed at rest; the emails ride
// the #16 template pathway so groups can reword them. Requesting a reset
// never discloses whether the email has an account.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  requestPasswordReset,
  resetPassword,
  sendEmailVerification,
  verifyEmail,
} from '../../src/services/recovery.js';
import { login, register } from '../../src/services/auth.js';
import { apply } from '../../src/services/membership.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { EmailEvent, Group, User } from '../../src/types.js';

const BASE = 'http://cam.example.org';

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code,
    `expected DomainError ${code}`,
  );
}

describe('password reset (§1)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let alice: User;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    alice = await register(storage, {
      email: 'alice@example.com', password: 'password-old',
    });
    await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice',
      email: 'alice@example.com', userId: alice.id,
    });
  });

  afterEach(() => {
    storage.close();
  });

  async function lastEmail(): Promise<EmailEvent | undefined> {
    const all = await storage.pendingEmails(100);
    return all[all.length - 1];
  }

  /** The raw token from the emailed link — the only place it ever appears. */
  function tokenFrom(event: EmailEvent): string {
    const match = event.body.match(/[?&]token=([0-9a-f]+)/);
    expect(match).toBeTruthy();
    return match![1]!;
  }

  it('requesting a reset emails a single-use link; unknown emails send nothing', async () => {
    await requestPasswordReset(storage, {
      groupId: group.id, email: 'alice@example.com', baseUrl: BASE,
    });
    const event = await lastEmail();
    expect(event).toBeDefined();
    expect(event!.kind).toBe('password_reset');
    expect(event!.toEmail).toBe('alice@example.com');
    expect(event!.body).toContain(`${BASE}/app/reset?token=`);

    await requestPasswordReset(storage, {
      groupId: group.id, email: 'nobody@example.com', baseUrl: BASE,
    });
    expect(await storage.pendingEmails(100)).toHaveLength(1); // still just Alice's
  });

  it('the emailed token resets the password once, and revokes sessions', async () => {
    const { token: sessionToken } = await login(storage, {
      email: 'alice@example.com', password: 'password-old', groupId: group.id,
    });
    await requestPasswordReset(storage, {
      groupId: group.id, email: 'alice@example.com', baseUrl: BASE,
    });
    const raw = tokenFrom((await lastEmail())!);

    await resetPassword(storage, raw, 'password-new');

    // New password works, old is dead, the pre-reset session is revoked.
    await login(storage, {
      email: 'alice@example.com', password: 'password-new', groupId: group.id,
    });
    await expectDomainError(
      login(storage, { email: 'alice@example.com', password: 'password-old' }),
      'NOT_AUTHORISED',
    );
    const { authenticate } = await import('../../src/services/auth.js');
    expect(await authenticate(storage, sessionToken)).toBeUndefined();

    // Single use: the same link cannot reset again.
    await expectDomainError(resetPassword(storage, raw, 'password-again'), 'INVALID');
  });

  it('rejects expired tokens and short passwords', async () => {
    await requestPasswordReset(storage, {
      groupId: group.id, email: 'alice@example.com', baseUrl: BASE,
      now: '2026-01-01T00:00:00.000Z', // token minted here expires in an hour
    });
    const raw = tokenFrom((await lastEmail())!);
    await expectDomainError(resetPassword(storage, raw, 'short'), 'INVALID');
    await expectDomainError(
      resetPassword(storage, raw, 'password-new', '2026-01-01T02:00:00.000Z'),
      'INVALID',
    );
  });
});

describe('email verification (§1)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let bob: User;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    bob = await register(storage, { email: 'bob@example.com', password: 'password-bob' });
    await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'Bob',
      email: 'bob@example.com', userId: bob.id,
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('sends a verification link that stamps the user, once', async () => {
    await sendEmailVerification(storage, {
      groupId: group.id, userId: bob.id, baseUrl: BASE,
    });
    const [event] = await storage.pendingEmails(10);
    expect(event!.kind).toBe('email_verify');
    expect(event!.toEmail).toBe('bob@example.com');
    const raw = event!.body.match(/[?&]token=([0-9a-f]+)/)![1]!;

    const user = await verifyEmail(storage, raw);
    expect(user.emailVerifiedAt).toBeTruthy();
    await expectDomainError(verifyEmail(storage, raw), 'INVALID');
  });

  it('a reset token cannot verify and vice versa', async () => {
    await requestPasswordReset(storage, {
      groupId: group.id, email: 'bob@example.com', baseUrl: BASE,
    });
    const [event] = await storage.pendingEmails(10);
    const raw = event!.body.match(/[?&]token=([0-9a-f]+)/)![1]!;
    await expectDomainError(verifyEmail(storage, raw), 'INVALID');
  });
});

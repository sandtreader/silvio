// Auth service (decision #2, data-model §1): global user identity, group-
// scoped sessions, server-side revocable, tokens and passwords hashed at rest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { register, login, authenticate, logout } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group, Member, User } from '../../src/types.js';

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code,
    `expected DomainError ${code}`,
  );
}

describe('auth service', () => {
  let storage: SqliteStorage;
  let group: Group;
  let user: User;
  let member: Member;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    user = await register(storage, { email: 'alice@example.com', password: 'hunter2hunter2' });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice Smith',
      email: 'alice@example.com', userId: user.id,
    });
    member = await approve(storage, applied.member.id);
  });

  afterEach(() => {
    storage.close();
  });

  it('registers a user without storing the raw password', async () => {
    expect(user.email).toBe('alice@example.com');
    const creds = await storage.credentialsForEmail('alice@example.com');
    expect(creds!.passwordHash).not.toContain('hunter2');
  });

  it('rejects duplicate email registration', async () => {
    await expectDomainError(
      register(storage, { email: 'alice@example.com', password: 'xxxxxxxxxxxx' }),
      'INVALID',
    );
  });

  it('rejects short passwords', async () => {
    await expectDomainError(
      register(storage, { email: 'b@example.com', password: 'short' }),
      'INVALID',
    );
  });

  it('login returns a token that authenticates to the user and group member', async () => {
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'hunter2hunter2', groupId: group.id,
    });
    expect(token).toMatch(/^[0-9a-f]{32,}$/);
    const ctx = await authenticate(storage, token);
    expect(ctx?.user.id).toBe(user.id);
    expect(ctx?.member?.id).toBe(member.id);
  });

  it('login fails identically for unknown email and wrong password', async () => {
    await expectDomainError(
      login(storage, { email: 'nobody@example.com', password: 'hunter2hunter2', groupId: group.id }),
      'NOT_AUTHORISED',
    );
    await expectDomainError(
      login(storage, { email: 'alice@example.com', password: 'wrong-password', groupId: group.id }),
      'NOT_AUTHORISED',
    );
  });

  it('login fails when the user has no membership in the group', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    await expectDomainError(
      login(storage, { email: 'alice@example.com', password: 'hunter2hunter2', groupId: other.id }),
      'NOT_AUTHORISED',
    );
  });

  it('a user in two groups gets the right member per group', async () => {
    const other = await storage.createGroup({ slug: 'other', name: 'Other' });
    const applied = await apply(storage, {
      groupId: other.id, displayName: 'Alice B', personName: 'Alice Smith',
      userId: user.id,
    });
    const otherMember = await approve(storage, applied.member.id);
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'hunter2hunter2', groupId: other.id,
    });
    const ctx = await authenticate(storage, token);
    expect(ctx?.member?.id).toBe(otherMember.id);
  });

  it('the session token is not stored raw', async () => {
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'hunter2hunter2', groupId: group.id,
    });
    expect(await storage.sessionByTokenHash(token)).toBeUndefined();
  });

  it('logout revokes the session immediately', async () => {
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'hunter2hunter2', groupId: group.id,
    });
    await logout(storage, token);
    expect(await authenticate(storage, token)).toBeUndefined();
  });

  it('garbage tokens do not authenticate', async () => {
    expect(await authenticate(storage, 'not-a-token')).toBeUndefined();
  });
});

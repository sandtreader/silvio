// Operator bootstrap: idempotent first-boot creation of the platform
// operator (env-driven or interactive; this tests the service, the
// entrypoint owns the prompting).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapOperator } from '../../src/services/bootstrap.js';
import { register, verifyCredentials } from '../../src/services/auth.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';

describe('bootstrapOperator', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = new SqliteStorage(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  it('creates the operator on an empty database', async () => {
    expect(await storage.operatorExists()).toBe(false);
    const result = await bootstrapOperator(storage, {
      email: 'op@example.com', password: 'operator-pass',
    });
    expect(result.created).toBe(true);
    expect(await storage.operatorExists()).toBe(true);
    const user = await verifyCredentials(storage, 'op@example.com', 'operator-pass');
    expect(user.isOperator).toBe(true);
  });

  it('is a no-op when any operator already exists', async () => {
    await bootstrapOperator(storage, { email: 'op@example.com', password: 'operator-pass' });
    const again = await bootstrapOperator(storage, {
      email: 'other@example.com', password: 'other-password',
    });
    expect(again.created).toBe(false);
    await expect(
      verifyCredentials(storage, 'other@example.com', 'other-password'),
    ).rejects.toBeInstanceOf(DomainError); // no second user was created
  });

  it('promotes an existing user rather than failing on duplicate email', async () => {
    await register(storage, { email: 'op@example.com', password: 'original-pass' });
    const result = await bootstrapOperator(storage, {
      email: 'op@example.com', password: 'ignored-here',
    });
    expect(result.created).toBe(true);
    // original password still works; the user is now an operator
    const user = await verifyCredentials(storage, 'op@example.com', 'original-pass');
    expect(user.isOperator).toBe(true);
  });

  it('rejects invalid passwords for brand-new operators', async () => {
    await expect(
      bootstrapOperator(storage, { email: 'op@example.com', password: 'short' }),
    ).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === 'INVALID');
    expect(await storage.operatorExists()).toBe(false);
  });
});

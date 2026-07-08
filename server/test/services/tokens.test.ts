// API token service (decision #9): issue with validation, authenticate raw
// bearer values, and enforce trade:autonomous caps from the journal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authenticateApiToken,
  checkTokenCaps,
  issueApiToken,
  type IssueTokenInput,
} from '../../src/services/tokens.js';
import { apply, approve } from '../../src/services/membership.js';
import { sendPayment } from '../../src/services/trading.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import { DomainError } from '../../src/services/errors.js';
import type { ApiScope, Currency, Group, Member, Person } from '../../src/types.js';

describe('api token service', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let alicePerson: Person;
  let bob: Member;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice',
    });
    alice = await approve(storage, applied.member.id);
    alicePerson = applied.person;
    const bobApplied = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'Bob',
    });
    bob = await approve(storage, bobApplied.member.id);
  });

  afterEach(() => {
    storage.close();
  });

  function input(overrides: Partial<IssueTokenInput> = {}): IssueTokenInput {
    return {
      memberId: alice.id,
      createdBy: alicePerson.id,
      label: 'my agent',
      scopes: ['account:read'] as ApiScope[],
      ...overrides,
    };
  }

  async function expectInvalid(promise: Promise<unknown>, containing: string): Promise<void> {
    await expect(promise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError && e.code === 'INVALID' && e.message.includes(containing),
      `expected INVALID mentioning "${containing}"`,
    );
  }

  describe('issueApiToken', () => {
    it('returns a slv_-prefixed raw token once, and the stored record', async () => {
      const { token, apiToken } = await issueApiToken(storage, input());
      expect(token).toMatch(/^slv_[0-9a-f]{48,}$/);
      expect(apiToken.label).toBe('my agent');
      expect(apiToken.scopes).toEqual(['account:read']);
      // The raw value is never stored.
      expect(JSON.stringify(await storage.listApiTokens(alice.id))).not.toContain(token);
    });

    it('rejects empty or unknown scopes', async () => {
      await expectInvalid(issueApiToken(storage, input({ scopes: [] })), 'scope');
      await expectInvalid(
        issueApiToken(storage, input({ scopes: ['admin:everything' as ApiScope] })),
        'scope',
      );
    });

    it('rejects an empty label', async () => {
      await expectInvalid(issueApiToken(storage, input({ label: '' })), 'label');
    });

    it('trade:autonomous requires a per-transaction cap', async () => {
      await expectInvalid(
        issueApiToken(storage, input({ scopes: ['trade:autonomous'] as ApiScope[] })),
        'maxTxAmount',
      );
      const { apiToken } = await issueApiToken(
        storage,
        input({ scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000 }),
      );
      expect(apiToken.maxTxAmount).toBe(5000);
    });

    it('a rolling cap needs both amount and period', async () => {
      await expectInvalid(
        issueApiToken(storage, input({ maxPeriodAmount: 10_000 })),
        'period',
      );
      await expectInvalid(issueApiToken(storage, input({ periodDays: 30 })), 'period');
    });
  });

  describe('authenticateApiToken', () => {
    it('resolves a live token to its member and touches lastUsedAt', async () => {
      const { token } = await issueApiToken(storage, input());
      const result = await authenticateApiToken(storage, token);
      expect(result?.member.id).toBe(alice.id);
      expect(result?.token.scopes).toEqual(['account:read']);
      const listed = await storage.listApiTokens(alice.id);
      expect(listed[0]!.lastUsedAt).toBeTruthy();
    });

    it('returns undefined for unknown raw values', async () => {
      expect(await authenticateApiToken(storage, 'slv_deadbeef')).toBeUndefined();
    });

    it('returns undefined for revoked tokens', async () => {
      const { token, apiToken } = await issueApiToken(storage, input());
      await storage.revokeApiToken(apiToken.id);
      expect(await authenticateApiToken(storage, token)).toBeUndefined();
    });

    it('returns undefined for expired tokens', async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const { token } = await issueApiToken(storage, input({ expiresAt: past }));
      expect(await authenticateApiToken(storage, token)).toBeUndefined();
    });
  });

  describe('checkTokenCaps (trade:autonomous)', () => {
    const NOW = new Date().toISOString();

    it('allows amounts within the per-transaction cap', async () => {
      const { apiToken } = await issueApiToken(
        storage,
        input({ scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000 }),
      );
      await expect(checkTokenCaps(storage, apiToken, 5000, NOW)).resolves.toBeUndefined();
    });

    it('rejects amounts over the per-transaction cap with the rule in the message', async () => {
      const { apiToken } = await issueApiToken(
        storage,
        input({ scopes: ['trade:autonomous'] as ApiScope[], maxTxAmount: 5000 }),
      );
      await expect(checkTokenCaps(storage, apiToken, 5001, NOW)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DomainError &&
          e.code === 'LIMIT_BREACHED' &&
          e.message.includes('5000'),
      );
    });

    it('enforces the rolling-period cap from journal spend', async () => {
      const { apiToken } = await issueApiToken(
        storage,
        input({
          scopes: ['trade:autonomous'] as ApiScope[],
          maxTxAmount: 5000,
          maxPeriodAmount: 6000,
          periodDays: 30,
        }),
      );
      // Spend 4000 via the token.
      await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount: 4000, actorPersonId: alicePerson.id,
        channel: 'mcp', apiTokenId: apiToken.id,
      });
      // 2000 more fits exactly; 2001 breaches.
      await expect(checkTokenCaps(storage, apiToken, 2000, NOW)).resolves.toBeUndefined();
      await expect(checkTokenCaps(storage, apiToken, 2001, NOW)).rejects.toSatisfy(
        (e: unknown) => e instanceof DomainError && e.code === 'LIMIT_BREACHED',
      );
    });
  });
});

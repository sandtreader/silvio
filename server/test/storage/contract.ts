// Storage contract tests: ledger invariants from specs/data-model.md and
// decisions #2, #5, #6, #10. Any Storage implementation must pass these.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Storage } from '../../src/storage/interface.js';
import type { Account, ApiScope, Currency, Group, NewTransaction } from '../../src/types.js';
import { StorageError } from '../../src/storage/errors.js';
import { txHash } from '../../src/ledger/hash.js';

export interface Fixture {
  storage: Storage;
  group: Group;
  cams: Currency; // primary currency
  palms: Currency; // second currency, same group
  alice: Account; // member account, cams
  bob: Account; // member account, cams
  community: Account; // community account, cams
  alicePalms: Account;
  bobPalms: Account;
  otherGroup: Group;
  otherCams: Currency;
  carol: Account; // member account in the OTHER group
}

async function makeFixture(storage: Storage): Promise<Fixture> {
  const group = await storage.createGroup({ slug: 'test', name: 'Test LETS' });
  const cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams' });
  const palms = await storage.createCurrency({ groupId: group.id, code: 'PLM', name: 'Palms' });
  const alice = await storage.createAccount({
    groupId: group.id, currencyId: cams.id, type: 'member', memberId: 'member-alice',
  });
  const bob = await storage.createAccount({
    groupId: group.id, currencyId: cams.id, type: 'member', memberId: 'member-bob',
  });
  const community = await storage.createAccount({
    groupId: group.id, currencyId: cams.id, type: 'community',
  });
  const alicePalms = await storage.createAccount({
    groupId: group.id, currencyId: palms.id, type: 'member', memberId: 'member-alice',
  });
  const bobPalms = await storage.createAccount({
    groupId: group.id, currencyId: palms.id, type: 'member', memberId: 'member-bob',
  });
  const otherGroup = await storage.createGroup({ slug: 'other', name: 'Other LETS' });
  const otherCams = await storage.createCurrency({
    groupId: otherGroup.id, code: 'CAM', name: 'Other Cams',
  });
  const carol = await storage.createAccount({
    groupId: otherGroup.id, currencyId: otherCams.id, type: 'member', memberId: 'member-carol',
  });
  return {
    storage, group, cams, palms, alice, bob, community,
    alicePalms, bobPalms, otherGroup, otherCams, carol,
  };
}

function trade(
  f: Fixture,
  overrides: Partial<NewTransaction> = {},
): NewTransaction {
  return {
    groupId: f.group.id,
    type: 'trade',
    state: 'committed',
    description: 'test trade',
    createdBy: 'person-alice',
    channel: 'web',
    entries: [
      { accountId: f.alice.id, amount: -100 },
      { accountId: f.bob.id, amount: 100 },
    ],
    ...overrides,
  };
}

async function expectStorageError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof StorageError && e.code === code,
    `expected StorageError with code ${code}`,
  );
}

export function storageContractTests(createStorage: () => Promise<Storage>): void {
  let f: Fixture;

  beforeEach(async () => {
    f = await makeFixture(await createStorage());
  });

  afterEach(() => {
    f.storage.close();
  });

  describe('posting committed transactions (#6)', () => {
    it('posts a balanced trade and updates both balances', async () => {
      const tx = await f.storage.post(trade(f));
      expect(tx.state).toBe('committed');
      expect(tx.committedAt).toBeDefined();
      expect(await f.storage.balance(f.alice.id)).toBe(-100);
      expect(await f.storage.balance(f.bob.id)).toBe(100);
    });

    it('assigns monotonic per-group seq starting at 1', async () => {
      const t1 = await f.storage.post(trade(f));
      const t2 = await f.storage.post(trade(f));
      const t3 = await f.storage.post(trade(f));
      expect([t1.seq, t2.seq, t3.seq]).toEqual([1, 2, 3]);
    });

    it('sets a hash at commit, chained and distinct per transaction (#10)', async () => {
      const t1 = await f.storage.post(trade(f));
      const t2 = await f.storage.post(trade(f));
      expect(t1.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(t2.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(t1.hash).not.toBe(t2.hash);
      expect(t1.hashVersion).toBe(1);
    });

    it('hashes are the domain-level canonical hash, portable across backends (#10)', async () => {
      // Any backend must produce byte-identical hashes from the shared
      // src/ledger/hash.ts encoding, so a storage migration keeps the chain.
      const t1 = await f.storage.post(trade(f));
      const t2 = await f.storage.post(trade(f));
      expect(t1.hash).toBe(
        txHash({
          prev: '',
          id: t1.id,
          groupId: t1.groupId,
          type: t1.type,
          seq: t1.seq!,
          committedAt: t1.committedAt!,
          entries: t1.entries,
        }),
      );
      expect(t2.hash).toBe(
        txHash({
          prev: t1.hash!,
          id: t2.id,
          groupId: t2.groupId,
          type: t2.type,
          seq: t2.seq!,
          committedAt: t2.committedAt!,
          entries: t2.entries,
        }),
      );
    });

    it('per-group seq: two groups each start at 1', async () => {
      const t1 = await f.storage.post(trade(f));
      const other = await f.storage.post({
        groupId: f.otherGroup.id,
        type: 'trade',
        state: 'committed',
        createdBy: 'person-carol',
        channel: 'web',
        entries: [
          { accountId: f.carol.id, amount: -5 },
          {
            accountId: (
              await f.storage.createAccount({
                groupId: f.otherGroup.id, currencyId: f.otherCams.id,
                type: 'member', memberId: 'member-dave',
              })
            ).id,
            amount: 5,
          },
        ],
      });
      expect(t1.seq).toBe(1);
      expect(other.seq).toBe(1);
    });

    it('supports multi-leg transactions (income-tie style split)', async () => {
      await f.storage.post(
        trade(f, {
          entries: [
            { accountId: f.alice.id, amount: -100 },
            { accountId: f.bob.id, amount: 95 },
            { accountId: f.community.id, amount: 5 },
          ],
        }),
      );
      expect(await f.storage.balance(f.alice.id)).toBe(-100);
      expect(await f.storage.balance(f.bob.id)).toBe(95);
      expect(await f.storage.balance(f.community.id)).toBe(5);
    });

    it('supports multi-currency atomic swaps: each currency sums to zero', async () => {
      await f.storage.post(
        trade(f, {
          entries: [
            { accountId: f.alice.id, amount: -50 }, // cams
            { accountId: f.bob.id, amount: 50 },
            { accountId: f.bobPalms.id, amount: -10 }, // palms the other way
            { accountId: f.alicePalms.id, amount: 10 },
          ],
        }),
      );
      expect(await f.storage.balance(f.alice.id)).toBe(-50);
      expect(await f.storage.balance(f.bob.id)).toBe(50);
      expect(await f.storage.balance(f.alicePalms.id)).toBe(10);
      expect(await f.storage.balance(f.bobPalms.id)).toBe(-10);
    });
  });

  describe('rejected transactions leave no trace (#6)', () => {
    it('rejects legs that do not sum to zero', async () => {
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: -100 },
              { accountId: f.bob.id, amount: 99 },
            ],
          }),
        ),
        'UNBALANCED',
      );
      expect(await f.storage.balance(f.alice.id)).toBe(0);
      expect(await f.storage.balance(f.bob.id)).toBe(0);
    });

    it('rejects multi-currency legs where one currency is unbalanced', async () => {
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: -50 },
              { accountId: f.bob.id, amount: 50 },
              { accountId: f.alicePalms.id, amount: 10 }, // palms don't balance
            ],
          }),
        ),
        'UNBALANCED',
      );
    });

    it('rejects fewer than two legs', async () => {
      await expectStorageError(
        f.storage.post(trade(f, { entries: [{ accountId: f.alice.id, amount: 0 }] })),
        'INVALID_TRANSACTION',
      );
    });

    it('rejects zero-amount and non-integer legs', async () => {
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: 0 },
              { accountId: f.bob.id, amount: 0 },
            ],
          }),
        ),
        'INVALID_TRANSACTION',
      );
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: -0.5 },
              { accountId: f.bob.id, amount: 0.5 },
            ],
          }),
        ),
        'INVALID_TRANSACTION',
      );
    });

    it('rejects legs on accounts of another group (#2)', async () => {
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: -5 },
              { accountId: f.carol.id, amount: 5 },
            ],
          }),
        ),
        'CROSS_GROUP',
      );
    });

    it('rejects unknown accounts', async () => {
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: -5 },
              { accountId: 'no-such-account', amount: 5 },
            ],
          }),
        ),
        'NOT_FOUND',
      );
    });

    it('failed post does not consume a seq', async () => {
      await expectStorageError(
        f.storage.post(
          trade(f, {
            entries: [
              { accountId: f.alice.id, amount: -100 },
              { accountId: f.bob.id, amount: 99 },
            ],
          }),
        ),
        'UNBALANCED',
      );
      const tx = await f.storage.post(trade(f));
      expect(tx.seq).toBe(1);
    });
  });

  describe('pending and the #5 state machine', () => {
    it('pending transactions have no balance effect, no seq, no hash', async () => {
      const tx = await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' }));
      expect(tx.state).toBe('pending');
      expect(tx.seq).toBeUndefined();
      expect(tx.hash).toBeUndefined();
      expect(tx.committedAt).toBeUndefined();
      expect(await f.storage.balance(f.alice.id)).toBe(0);
      expect(await f.storage.balance(f.bob.id)).toBe(0);
    });

    it('committing a pending transaction assigns seq/hash and applies balances', async () => {
      const pending = await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' }));
      const committed = await f.storage.transition(pending.id, 'committed', {
        personId: 'person-alice',
      });
      expect(committed.state).toBe('committed');
      expect(committed.seq).toBe(1);
      expect(committed.hash).toBeDefined();
      expect(await f.storage.balance(f.bob.id)).toBe(100);
    });

    it('declined/cancelled/expired never touch balances', async () => {
      for (const to of ['declined', 'cancelled', 'expired'] as const) {
        const pending = await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' }));
        const ended = await f.storage.transition(pending.id, to, { personId: 'p' });
        expect(ended.state).toBe(to);
        expect(ended.seq).toBeUndefined();
      }
      expect(await f.storage.balance(f.alice.id)).toBe(0);
    });

    it('commit order, not creation order, determines seq', async () => {
      const p1 = await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' }));
      const direct = await f.storage.post(trade(f)); // committed immediately
      const c1 = await f.storage.transition(p1.id, 'committed', { personId: 'p' });
      expect(direct.seq).toBe(1);
      expect(c1.seq).toBe(2);
    });

    it('rejects transitions out of terminal states', async () => {
      const committed = await f.storage.post(trade(f));
      await expectStorageError(
        f.storage.transition(committed.id, 'cancelled', { personId: 'p' }),
        'INVALID_TRANSITION',
      );
      const pending = await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' }));
      const declined = await f.storage.transition(pending.id, 'declined', { personId: 'p' });
      await expectStorageError(
        f.storage.transition(declined.id, 'committed', { personId: 'p' }),
        'INVALID_TRANSITION',
      );
    });

    it('rejects transition to pending', async () => {
      const pending = await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' }));
      await expectStorageError(
        f.storage.transition(pending.id, 'pending', { personId: 'p' }),
        'INVALID_TRANSITION',
      );
    });
  });

  describe('idempotency (#6)', () => {
    it('replaying an idempotency key returns the original, posting once', async () => {
      const t1 = await f.storage.post(trade(f), 'key-1');
      const t2 = await f.storage.post(trade(f), 'key-1');
      expect(t2.id).toBe(t1.id);
      expect(await f.storage.balance(f.bob.id)).toBe(100);
    });

    it('idempotency keys are scoped per group', async () => {
      const dave = await f.storage.createAccount({
        groupId: f.otherGroup.id, currencyId: f.otherCams.id,
        type: 'member', memberId: 'member-dave',
      });
      const t1 = await f.storage.post(trade(f), 'shared-key');
      const t2 = await f.storage.post(
        {
          groupId: f.otherGroup.id,
          type: 'trade',
          state: 'committed',
          createdBy: 'person-carol',
          channel: 'web',
          entries: [
            { accountId: f.carol.id, amount: -5 },
            { accountId: dave.id, amount: 5 },
          ],
        },
        'shared-key',
      );
      expect(t2.id).not.toBe(t1.id);
    });
  });

  describe('reversal (#5, #6)', () => {
    it('a reversal is a new transaction linked by reversesId', async () => {
      const original = await f.storage.post(trade(f));
      const reversal = await f.storage.post(
        trade(f, {
          type: 'reversal',
          reversesId: original.id,
          entries: [
            { accountId: f.alice.id, amount: 100 },
            { accountId: f.bob.id, amount: -100 },
          ],
        }),
      );
      expect(reversal.reversesId).toBe(original.id);
      expect(await f.storage.balance(f.alice.id)).toBe(0);
      expect(await f.storage.balance(f.bob.id)).toBe(0);
      // original remains committed and untouched
      const again = await f.storage.getTransaction(original.id);
      expect(again.state).toBe('committed');
    });
  });

  describe('transaction search (admin list)', () => {
    // Fixture posted per test: a committed cams trade alice->bob 'veg box',
    // a pending cams invoice bob->alice 'bike repair', a committed palms
    // trade 'plants', a demurrage posting, and a trade in the other group.
    async function seed(): Promise<{ veg: string; bike: string; plants: string; dem: string }> {
      const veg = (await f.storage.post(trade(f, { description: 'veg box', reference: 'VB-1' }))).id;
      const bike = (
        await f.storage.post(
          trade(f, {
            state: 'pending',
            flow: 'invoice',
            description: 'bike repair',
            entries: [
              { accountId: f.alice.id, amount: -200 },
              { accountId: f.bob.id, amount: 200 },
            ],
          }),
        )
      ).id;
      const plants = (
        await f.storage.post(
          trade(f, {
            description: 'plants',
            entries: [
              { accountId: f.alicePalms.id, amount: -50 },
              { accountId: f.bobPalms.id, amount: 50 },
            ],
          }),
        )
      ).id;
      const dem = (
        await f.storage.post(
          trade(f, {
            type: 'demurrage',
            description: 'monthly demurrage',
            entries: [
              { accountId: f.alice.id, amount: -3 },
              { accountId: f.community.id, amount: 3 },
            ],
          }),
        )
      ).id;
      const dave = await f.storage.createAccount({
        groupId: f.otherGroup.id, currencyId: f.otherCams.id,
        type: 'member', memberId: 'member-dave',
      });
      await f.storage.post(
        trade(f, {
          groupId: f.otherGroup.id,
          description: 'other group trade',
          entries: [
            { accountId: f.carol.id, amount: -10 },
            { accountId: dave.id, amount: 10 },
          ],
        }),
      );
      return { veg, bike, plants, dem };
    }

    it('lists only this group, newest page first, with a total', async () => {
      const ids = await seed();
      const { transactions, total } = await f.storage.listTransactions(f.group.id);
      expect(total).toBe(4);
      expect(transactions.map((t) => t.id).sort()).toEqual(
        [ids.veg, ids.bike, ids.plants, ids.dem].sort(),
      );
      // Full transactions, entries included.
      expect(transactions.every((t) => t.entries.length === 2)).toBe(true);
    });

    it('filters by member (any account of theirs)', async () => {
      const ids = await seed();
      const { transactions } = await f.storage.listTransactions(f.group.id, {
        memberId: 'member-bob',
      });
      expect(transactions.map((t) => t.id).sort()).toEqual(
        [ids.veg, ids.bike, ids.plants].sort(), // not the demurrage posting
      );
    });

    it('filters by currency', async () => {
      const ids = await seed();
      const { transactions } = await f.storage.listTransactions(f.group.id, {
        currencyId: f.palms.id,
      });
      expect(transactions.map((t) => t.id)).toEqual([ids.plants]);
    });

    it('filters by type and state', async () => {
      const ids = await seed();
      const byType = await f.storage.listTransactions(f.group.id, { type: 'demurrage' });
      expect(byType.transactions.map((t) => t.id)).toEqual([ids.dem]);
      const byState = await f.storage.listTransactions(f.group.id, { state: 'pending' });
      expect(byState.transactions.map((t) => t.id)).toEqual([ids.bike]);
    });

    it('text search covers description and reference, case-insensitively', async () => {
      const ids = await seed();
      const byDesc = await f.storage.listTransactions(f.group.id, { text: 'BIKE' });
      expect(byDesc.transactions.map((t) => t.id)).toEqual([ids.bike]);
      const byRef = await f.storage.listTransactions(f.group.id, { text: 'vb-1' });
      expect(byRef.transactions.map((t) => t.id)).toEqual([ids.veg]);
    });

    it('filters compose', async () => {
      const ids = await seed();
      const { transactions, total } = await f.storage.listTransactions(f.group.id, {
        memberId: 'member-alice',
        currencyId: f.cams.id,
        type: 'trade',
      });
      expect(total).toBe(2);
      expect(transactions.map((t) => t.id).sort()).toEqual([ids.veg, ids.bike].sort());
    });

    it('paginates with limit and offset; total counts all matches', async () => {
      await seed();
      const page1 = await f.storage.listTransactions(f.group.id, { limit: 3 });
      const page2 = await f.storage.listTransactions(f.group.id, { limit: 3, offset: 3 });
      expect(page1.total).toBe(4);
      expect(page2.total).toBe(4);
      expect(page1.transactions).toHaveLength(3);
      expect(page2.transactions).toHaveLength(1);
      const all = [...page1.transactions, ...page2.transactions].map((t) => t.id);
      expect(new Set(all).size).toBe(4); // stable order: no duplicates across pages
    });
  });

  describe('restrictions read (#3)', () => {
    // Restrictions reference real members, so this block creates them
    // (unlike the ledger tests, which use loose synthetic member ids).
    async function makeRealMember(name: string): Promise<string> {
      const member = await f.storage.createMember({
        groupId: f.group.id, displayName: name,
      });
      return member.id;
    }

    it('lists only active restrictions for the group, oldest first', async () => {
      const restricted = await makeRealMember('Restricted');
      const lifted = await makeRealMember('Lifted');
      const clean = await makeRealMember('Clean');
      await f.storage.imposeRestriction(restricted, 'runaway balance', 'admin-1');
      await f.storage.imposeRestriction(lifted, 'temporary', 'admin-1');
      await f.storage.liftRestriction(lifted, 'admin-2');

      const active = await f.storage.activeRestrictions(f.group.id);
      expect(active).toHaveLength(1);
      expect(active[0]!.memberId).toBe(restricted);
      expect(active[0]!.reason).toBe('runaway balance');
      expect(active[0]!.imposedBy).toBe('admin-1');
      expect(active[0]!.liftedAt).toBeUndefined();
      expect(active.map((r) => r.memberId)).not.toContain(clean);
    });

    it('is group-scoped', async () => {
      const other = await f.storage.createMember({
        groupId: f.otherGroup.id, displayName: 'Elsewhere',
      });
      await f.storage.imposeRestriction(other.id, 'other group', 'admin-1');
      expect(await f.storage.activeRestrictions(f.group.id)).toEqual([]);
      expect(await f.storage.activeRestrictions(f.otherGroup.id)).toHaveLength(1);
    });
  });

  describe('statement (#6)', () => {
    it('returns committed lines in seq order with running balance', async () => {
      await f.storage.post(trade(f)); // alice -100
      await f.storage.post(
        trade(f, {
          entries: [
            { accountId: f.bob.id, amount: -30 },
            { accountId: f.alice.id, amount: 30 },
          ],
        }),
      );
      await f.storage.post(trade(f, { state: 'pending', flow: 'invoice' })); // excluded
      const lines = await f.storage.statement(f.alice.id);
      expect(lines.map((l) => l.amount)).toEqual([-100, 30]);
      expect(lines.map((l) => l.runningBalance)).toEqual([-100, -70]);
      expect(lines[0]!.seq).toBeLessThan(lines[1]!.seq);
    });
  });

  describe('verify (#6, #10)', () => {
    it('passes on a clean ledger', async () => {
      await f.storage.post(trade(f));
      await f.storage.post(
        trade(f, {
          entries: [
            { accountId: f.alice.id, amount: -50 },
            { accountId: f.bob.id, amount: 50 },
            { accountId: f.bobPalms.id, amount: -10 },
            { accountId: f.alicePalms.id, amount: 10 },
          ],
        }),
      );
      const report = await f.storage.verify(f.group.id);
      expect(report.errors).toEqual([]);
      expect(report.ok).toBe(true);
    });

    it('passes on an empty ledger', async () => {
      const report = await f.storage.verify(f.group.id);
      expect(report.ok).toBe(true);
    });
  });

  describe('api tokens (#9)', () => {
    const tokenInput = (overrides: Record<string, unknown> = {}) => ({
      memberId: 'member-alice',
      createdBy: 'person-alice',
      tokenHash: 'hash-one',
      label: 'my agent',
      scopes: ['account:read', 'trade:request'] as ApiScope[],
      ...overrides,
    });

    it('creates a token and fetches it by hash', async () => {
      const created = await f.storage.createApiToken(tokenInput());
      expect(created.id).toBeTruthy();
      expect(created.label).toBe('my agent');
      expect(created.scopes).toEqual(['account:read', 'trade:request']);
      expect(created.createdAt).toBeTruthy();
      expect(created.revokedAt).toBeUndefined();
      expect(created.lastUsedAt).toBeUndefined();

      const fetched = await f.storage.apiTokenByHash('hash-one');
      expect(fetched?.id).toBe(created.id);
      expect(await f.storage.apiTokenByHash('no-such-hash')).toBeUndefined();
    });

    it('round-trips the autonomous caps and expiry', async () => {
      const created = await f.storage.createApiToken(
        tokenInput({
          scopes: ['trade:autonomous'] as ApiScope[],
          maxTxAmount: 5000,
          maxPeriodAmount: 20_000,
          periodDays: 30,
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
      );
      const fetched = await f.storage.apiTokenByHash('hash-one');
      expect(fetched).toMatchObject({
        id: created.id,
        maxTxAmount: 5000,
        maxPeriodAmount: 20_000,
        periodDays: 30,
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
    });

    it('revoked tokens disappear from hash lookup but stay listed', async () => {
      const created = await f.storage.createApiToken(tokenInput());
      await f.storage.revokeApiToken(created.id);
      expect(await f.storage.apiTokenByHash('hash-one')).toBeUndefined();

      const listed = await f.storage.listApiTokens('member-alice');
      expect(listed).toHaveLength(1);
      expect(listed[0]!.revokedAt).toBeTruthy();
    });

    it('lists only the member’s own tokens', async () => {
      await f.storage.createApiToken(tokenInput());
      await f.storage.createApiToken(
        tokenInput({ memberId: 'member-bob', tokenHash: 'hash-two', label: 'bob agent' }),
      );
      const alices = await f.storage.listApiTokens('member-alice');
      expect(alices.map((t) => t.label)).toEqual(['my agent']);
    });

    it('touch updates lastUsedAt', async () => {
      const created = await f.storage.createApiToken(tokenInput());
      await f.storage.touchApiToken(created.id, '2026-07-08T12:00:00.000Z');
      const fetched = await f.storage.apiTokenByHash('hash-one');
      expect(fetched?.lastUsedAt).toBe('2026-07-08T12:00:00.000Z');
    });

    it('tokenSpend sums only the member’s outward committed legs via this token', async () => {
      const token = await f.storage.createApiToken(tokenInput());
      // Outward via the token: counts.
      await f.storage.post(trade(f, { apiTokenId: token.id, channel: 'mcp' }));
      // Outward without the token: does not count.
      await f.storage.post(trade(f));
      // Inward via the token (alice receives): does not count.
      await f.storage.post(
        trade(f, {
          apiTokenId: token.id,
          channel: 'mcp',
          entries: [
            { accountId: f.bob.id, amount: -40 },
            { accountId: f.alice.id, amount: 40 },
          ],
        }),
      );
      // Pending via the token: does not count until committed.
      await f.storage.post(
        trade(f, { apiTokenId: token.id, channel: 'mcp', state: 'pending' }),
      );

      expect(await f.storage.tokenSpend(token.id, '2000-01-01T00:00:00.000Z')).toBe(100);
      // Nothing committed after a future cutoff.
      expect(await f.storage.tokenSpend(token.id, '2100-01-01T00:00:00.000Z')).toBe(0);
    });
  });

  describe('pages (CMS, decision #13, data-model §6)', () => {
    function draft(overrides: Record<string, unknown> = {}) {
      return {
        groupId: f.group.id,
        slug: 'agreement',
        title: 'Our Agreement',
        body: '# Agreement\n\nBe excellent to each other.',
        visibility: 'public' as const,
        ...overrides,
      };
    }

    it('creates a page, position defaulting to 0', async () => {
      const page = await f.storage.createPage(draft());
      expect(page.id).toBeTruthy();
      expect(page.groupId).toBe(f.group.id);
      expect(page.slug).toBe('agreement');
      expect(page.title).toBe('Our Agreement');
      expect(page.body).toContain('Be excellent');
      expect(page.visibility).toBe('public');
      expect(page.position).toBe(0);
      expect(page.createdAt).toBeTruthy();
      expect(page.updatedAt).toBeTruthy();
    });

    it('slug is unique per group, not globally', async () => {
      await f.storage.createPage(draft());
      await expectStorageError(
        f.storage.createPage(draft({ title: 'Duplicate' })),
        'CONFLICT',
      );
      // Same slug in another group is fine.
      const other = await f.storage.createPage(draft({ groupId: f.otherGroup.id }));
      expect(other.groupId).toBe(f.otherGroup.id);
    });

    it('pageBySlug fetches within the group; unknown slug is undefined', async () => {
      await f.storage.createPage(draft());
      const page = await f.storage.pageBySlug(f.group.id, 'agreement');
      expect(page?.title).toBe('Our Agreement');
      expect(await f.storage.pageBySlug(f.group.id, 'missing')).toBeUndefined();
      expect(await f.storage.pageBySlug(f.otherGroup.id, 'agreement')).toBeUndefined();
    });

    it('listPages is group-scoped, ordered by position then slug', async () => {
      await f.storage.createPage(draft({ slug: 'zebra', title: 'Z', position: 1 }));
      await f.storage.createPage(draft({ slug: 'help', title: 'Help', position: 2 }));
      await f.storage.createPage(draft({ slug: 'about', title: 'About', position: 1 }));
      await f.storage.createPage(draft({ groupId: f.otherGroup.id, slug: 'elsewhere' }));
      const pages = await f.storage.listPages(f.group.id);
      expect(pages.map((p) => p.slug)).toEqual(['about', 'zebra', 'help']);
    });

    it('updatePage patches fields; a slug collision is a conflict', async () => {
      const page = await f.storage.createPage(draft());
      await f.storage.createPage(draft({ slug: 'help', title: 'Help' }));
      const updated = await f.storage.updatePage(page.id, {
        title: 'The Agreement',
        body: 'New body',
        visibility: 'members',
        position: 5,
      });
      expect(updated.title).toBe('The Agreement');
      expect(updated.body).toBe('New body');
      expect(updated.visibility).toBe('members');
      expect(updated.position).toBe(5);
      expect(updated.slug).toBe('agreement'); // untouched
      await expectStorageError(
        f.storage.updatePage(page.id, { slug: 'help' }),
        'CONFLICT',
      );
    });

    it('deletePage removes it; getPage on the gone id is NOT_FOUND', async () => {
      const page = await f.storage.createPage(draft());
      expect((await f.storage.getPage(page.id)).id).toBe(page.id);
      await f.storage.deletePage(page.id);
      expect(await f.storage.pageBySlug(f.group.id, 'agreement')).toBeUndefined();
      await expectStorageError(f.storage.getPage(page.id), 'NOT_FOUND');
    });
  });

  describe('news items (CMS, decision #13, data-model §6)', () => {
    function draft(overrides: Record<string, unknown> = {}) {
      return {
        groupId: f.group.id,
        title: 'Market day',
        body: 'See you *Saturday*.',
        publishedAt: '2026-07-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('creates and fetches a news item', async () => {
      const item = await f.storage.createNewsItem(draft());
      expect(item.id).toBeTruthy();
      expect(item.groupId).toBe(f.group.id);
      expect(item.title).toBe('Market day');
      expect(item.body).toContain('Saturday');
      expect(item.publishedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(item.expiresAt).toBeUndefined();
      expect((await f.storage.getNewsItem(item.id)).id).toBe(item.id);
    });

    it('listNews with currentAt hides future and expired items, newest first', async () => {
      await f.storage.createNewsItem(draft({ title: 'Old news', publishedAt: '2026-01-01T00:00:00.000Z' }));
      await f.storage.createNewsItem(draft({ title: 'Current' }));
      await f.storage.createNewsItem(
        draft({ title: 'Expired', publishedAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-07-01T00:00:00.000Z' }),
      );
      await f.storage.createNewsItem(
        draft({ title: 'Scheduled', publishedAt: '2026-08-01T00:00:00.000Z' }),
      );
      await f.storage.createNewsItem(draft({ groupId: f.otherGroup.id, title: 'Elsewhere' }));

      const current = await f.storage.listNews(f.group.id, { currentAt: '2026-07-09T00:00:00.000Z' });
      expect(current.map((n) => n.title)).toEqual(['Current', 'Old news']);
      // Without currentAt: everything in the group, newest publishedAt first.
      const all = await f.storage.listNews(f.group.id, {});
      expect(all.map((n) => n.title)).toEqual(['Scheduled', 'Current', 'Expired', 'Old news']);
    });

    it('updates and deletes; unknown ids are NOT_FOUND', async () => {
      const item = await f.storage.createNewsItem(draft());
      const updated = await f.storage.updateNewsItem(item.id, {
        title: 'Market day moved',
        expiresAt: '2026-12-01T00:00:00.000Z',
      });
      expect(updated.title).toBe('Market day moved');
      expect(updated.expiresAt).toBe('2026-12-01T00:00:00.000Z');
      await f.storage.deleteNewsItem(item.id);
      await expectStorageError(f.storage.getNewsItem(item.id), 'NOT_FOUND');
      await expectStorageError(f.storage.updateNewsItem(item.id, { title: 'X' }), 'NOT_FOUND');
    });
  });

  describe('email events (outbound log, data-model §6)', () => {
    function draft(overrides: Record<string, string> = {}) {
      return {
        groupId: f.group.id,
        personId: 'person-alice',
        kind: 'welcome',
        dedupKey: 'welcome:member-alice:person-alice',
        toEmail: 'alice@example.com',
        subject: 'Welcome to Test LETS',
        body: 'Hello Alice',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('enqueues an email and returns the stored event', async () => {
      const event = await f.storage.enqueueEmail(draft());
      expect(event).toBeDefined();
      expect(event!.id).toBeTruthy();
      expect(event!.groupId).toBe(f.group.id);
      expect(event!.personId).toBe('person-alice');
      expect(event!.kind).toBe('welcome');
      expect(event!.dedupKey).toBe('welcome:member-alice:person-alice');
      expect(event!.toEmail).toBe('alice@example.com');
      expect(event!.subject).toBe('Welcome to Test LETS');
      expect(event!.body).toBe('Hello Alice');
      expect(event!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(event!.sentAt).toBeUndefined();
      expect(event!.attempts).toBe(0);
    });

    it('a duplicate dedup key is a silent no-op returning undefined', async () => {
      await f.storage.enqueueEmail(draft());
      const dup = await f.storage.enqueueEmail(draft({ subject: 'Different subject' }));
      expect(dup).toBeUndefined();
      const pending = await f.storage.pendingEmails(10);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.subject).toBe('Welcome to Test LETS');
    });

    it('pendingEmails returns unsent emails oldest first, up to the limit', async () => {
      await f.storage.enqueueEmail(
        draft({ dedupKey: 'k2', createdAt: '2026-01-02T00:00:00.000Z' }),
      );
      await f.storage.enqueueEmail(
        draft({ dedupKey: 'k1', createdAt: '2026-01-01T00:00:00.000Z' }),
      );
      await f.storage.enqueueEmail(
        draft({ dedupKey: 'k3', createdAt: '2026-01-03T00:00:00.000Z' }),
      );
      const pending = await f.storage.pendingEmails(2);
      expect(pending.map((e) => e.dedupKey)).toEqual(['k1', 'k2']);
    });

    it('markEmailSent stamps sentAt and removes it from pending', async () => {
      const event = await f.storage.enqueueEmail(draft());
      await f.storage.markEmailSent(event!.id, '2026-01-01T00:05:00.000Z');
      expect(await f.storage.pendingEmails(10)).toEqual([]);
    });

    it('markEmailFailed records the error and keeps it pending until 3 attempts', async () => {
      const event = await f.storage.enqueueEmail(draft());
      await f.storage.markEmailFailed(event!.id, 'connection refused');
      let pending = await f.storage.pendingEmails(10);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.attempts).toBe(1);
      expect(pending[0]!.lastError).toBe('connection refused');

      await f.storage.markEmailFailed(event!.id, 'connection refused');
      await f.storage.markEmailFailed(event!.id, 'still down');
      // Three failed attempts: given up, no longer offered for delivery.
      expect(await f.storage.pendingEmails(10)).toEqual([]);
    });
  });
}

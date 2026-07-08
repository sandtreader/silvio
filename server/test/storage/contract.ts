// Storage contract tests: ledger invariants from specs/data-model.md and
// decisions #2, #5, #6, #10. Any Storage implementation must pass these.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Storage } from '../../src/storage/interface.js';
import type { Account, Currency, Group, NewTransaction } from '../../src/storage/types.js';
import { StorageError } from '../../src/storage/types.js';
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
}

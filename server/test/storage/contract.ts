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
    it('returns committed lines newest first with running balance and total', async () => {
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
      const { lines, total } = await f.storage.statement(f.alice.id);
      expect(total).toBe(2);
      expect(lines.map((l) => l.amount)).toEqual([30, -100]);
      expect(lines.map((l) => l.runningBalance)).toEqual([-70, -100]);
      expect(lines[0]!.seq).toBeGreaterThan(lines[1]!.seq);
    });

    it('pages from the newest, running balances staying correct', async () => {
      // Five trades of -10 each: balances -10 … -50, newest first -50 … -10.
      for (let i = 0; i < 5; i += 1) {
        await f.storage.post(trade(f, {
          entries: [
            { accountId: f.alice.id, amount: -10 },
            { accountId: f.bob.id, amount: 10 },
          ],
        }));
      }
      const page = await f.storage.statement(f.alice.id, { limit: 2, offset: 1 });
      expect(page.total).toBe(5);
      expect(page.lines.map((l) => l.runningBalance)).toEqual([-40, -30]);
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

  describe('images (decision #14)', () => {
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(100, 1),
    ]);

    function draft(overrides: Record<string, unknown> = {}) {
      return {
        groupId: f.group.id,
        ownerKind: 'cms' as const,
        mime: 'image/png',
        data: PNG,
        createdBy: 'person-alice',
        ...overrides,
      };
    }

    it('stores and fetches an image; metadata and bytes separately', async () => {
      const image = await f.storage.createImage(draft());
      expect(image.id).toBeTruthy();
      expect(image.groupId).toBe(f.group.id);
      expect(image.ownerKind).toBe('cms');
      expect(image.ownerId).toBeUndefined();
      expect(image.mime).toBe('image/png');
      expect(image.size).toBe(PNG.length);
      expect(image.createdAt).toBeTruthy();
      expect('data' in image).toBe(false); // metadata only, blobs stay in storage

      const fetched = await f.storage.getImage(image.id);
      expect(fetched.size).toBe(PNG.length);
      const data = await f.storage.imageData(image.id);
      expect(Buffer.compare(data, PNG)).toBe(0);
    });

    it('lists group images, filtered by owner', async () => {
      await f.storage.createImage(draft());
      await f.storage.createImage(
        draft({ ownerKind: 'listing', ownerId: 'listing-1' }),
      );
      await f.storage.createImage(draft({ groupId: f.otherGroup.id }));

      expect(await f.storage.listImages(f.group.id, {})).toHaveLength(2);
      const cms = await f.storage.listImages(f.group.id, { ownerKind: 'cms' });
      expect(cms).toHaveLength(1);
      expect(cms[0]!.ownerKind).toBe('cms');
      const owned = await f.storage.listImages(f.group.id, {
        ownerKind: 'listing', ownerId: 'listing-1',
      });
      expect(owned).toHaveLength(1);
    });

    it('deletes; unknown ids are NOT_FOUND', async () => {
      const image = await f.storage.createImage(draft());
      await f.storage.deleteImage(image.id);
      await expectStorageError(f.storage.getImage(image.id), 'NOT_FOUND');
      await expectStorageError(f.storage.imageData(image.id), 'NOT_FOUND');
    });

    it('imagesTotalSize sums the group’s bytes', async () => {
      expect(await f.storage.imagesTotalSize(f.group.id)).toBe(0);
      await f.storage.createImage(draft());
      await f.storage.createImage(draft({ ownerKind: 'member', ownerId: 'member-alice' }));
      await f.storage.createImage(draft({ groupId: f.otherGroup.id }));
      expect(await f.storage.imagesTotalSize(f.group.id)).toBe(2 * PNG.length);
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

    it('carries the per-group sender snapshot (#16)', async () => {
      const event = await f.storage.enqueueEmail(
        draft({ fromEmail: 'lets@cam.example.org' }),
      );
      expect(event!.fromEmail).toBe('lets@cam.example.org');
      // Absent stays absent: delivery falls back to the instance default.
      const plain = await f.storage.enqueueEmail(draft({ dedupKey: 'k-plain' }));
      expect(plain!.fromEmail).toBeUndefined();
    });
  });

  describe('email templates (#16): per-group overrides', () => {
    it('setEmailTemplate upserts per (group, kind)', async () => {
      const created = await f.storage.setEmailTemplate({
        groupId: f.group.id, kind: 'welcome', subject: 'Hi {{memberName}}', body: 'Welcome!',
      });
      expect(created.subject).toBe('Hi {{memberName}}');
      const replaced = await f.storage.setEmailTemplate({
        groupId: f.group.id, kind: 'welcome', subject: 'Hello', body: 'New body',
      });
      expect(replaced.body).toBe('New body');
      expect(await f.storage.getEmailTemplate(f.group.id, 'welcome')).toMatchObject({
        kind: 'welcome', subject: 'Hello', body: 'New body',
      });
      expect(await f.storage.listEmailTemplates(f.group.id)).toHaveLength(1);
    });

    it('overrides are per group and absent by default', async () => {
      expect(await f.storage.getEmailTemplate(f.group.id, 'welcome')).toBeUndefined();
      await f.storage.setEmailTemplate({
        groupId: f.group.id, kind: 'welcome', subject: 's', body: 'b',
      });
      expect(await f.storage.getEmailTemplate(f.otherGroup.id, 'welcome')).toBeUndefined();
      expect(await f.storage.listEmailTemplates(f.otherGroup.id)).toEqual([]);
    });

    it('deleteEmailTemplate reverts to the default; a no-op when none', async () => {
      await f.storage.setEmailTemplate({
        groupId: f.group.id, kind: 'welcome', subject: 's', body: 'b',
      });
      await f.storage.deleteEmailTemplate(f.group.id, 'welcome');
      expect(await f.storage.getEmailTemplate(f.group.id, 'welcome')).toBeUndefined();
      await f.storage.deleteEmailTemplate(f.group.id, 'welcome'); // still fine
    });
  });

  describe('one-time tokens (data-model §1): reset/verify/invite', () => {
    function draft(overrides: Record<string, string> = {}) {
      return {
        email: 'alice@example.com',
        purpose: 'password_reset' as const,
        tokenHash: 'hash-1',
        expiresAt: '2026-01-01T01:00:00.000Z',
        ...overrides,
      };
    }

    it('creates and finds by token hash', async () => {
      const created = await f.storage.createOneTimeToken(draft({ userId: 'user-1' }));
      expect(created.id).toBeTruthy();
      expect(created.purpose).toBe('password_reset');
      expect(created.usedAt).toBeUndefined();
      const found = await f.storage.oneTimeTokenByHash('hash-1');
      expect(found).toMatchObject({
        id: created.id, userId: 'user-1', email: 'alice@example.com',
        expiresAt: '2026-01-01T01:00:00.000Z',
      });
      expect(await f.storage.oneTimeTokenByHash('nope')).toBeUndefined();
    });

    it('marking used is permanent and visible', async () => {
      const created = await f.storage.createOneTimeToken(draft());
      await f.storage.markOneTimeTokenUsed(created.id, '2026-01-01T00:30:00.000Z');
      const found = await f.storage.oneTimeTokenByHash('hash-1');
      expect(found!.usedAt).toBe('2026-01-01T00:30:00.000Z');
    });
  });

  describe('password reset & verification support (§1)', () => {
    it('updateUserPassword replaces the credential hash', async () => {
      const user = await f.storage.createUser({
        email: 'reset@example.com', passwordHash: 'old-hash',
      });
      await f.storage.updateUserPassword(user.id, 'new-hash');
      const creds = await f.storage.credentialsForEmail('reset@example.com');
      expect(creds!.passwordHash).toBe('new-hash');
    });

    it('revokeSessionsForUser kills every session of that user only', async () => {
      const user = await f.storage.createUser({
        email: 'u1@example.com', passwordHash: 'h',
      });
      const other = await f.storage.createUser({
        email: 'u2@example.com', passwordHash: 'h',
      });
      await f.storage.createSession({
        userId: user.id, tokenHash: 't1', expiresAt: '2027-01-01T00:00:00.000Z',
      });
      await f.storage.createSession({
        userId: other.id, tokenHash: 't2', expiresAt: '2027-01-01T00:00:00.000Z',
      });
      await f.storage.revokeSessionsForUser(user.id);
      expect(await f.storage.sessionByTokenHash('t1')).toBeUndefined();
      expect(await f.storage.sessionByTokenHash('t2')).toBeDefined();
    });

    it('markUserEmailVerified stamps the user', async () => {
      const user = await f.storage.createUser({
        email: 'v@example.com', passwordHash: 'h',
      });
      expect(user.emailVerifiedAt).toBeUndefined();
      const verified = await f.storage.markUserEmailVerified(
        user.id, '2026-01-01T00:00:00.000Z',
      );
      expect(verified.emailVerifiedAt).toBe('2026-01-01T00:00:00.000Z');
      expect((await f.storage.getUser(user.id)).emailVerifiedAt)
        .toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('post with an explicit timestamp (seeding/import support)', () => {
    it('honours atIso for created/committed and keeps the chain verifiable', async () => {
      const past = await f.storage.post(
        trade(f),
        undefined,
        '2025-03-15T12:00:00.000Z',
      );
      expect(past.createdAt).toBe('2025-03-15T12:00:00.000Z');
      expect(past.committedAt).toBe('2025-03-15T12:00:00.000Z');

      // A later transaction without atIso stamps now, as ever.
      const current = await f.storage.post(trade(f));
      expect(current.committedAt! > past.committedAt!).toBe(true);

      // The backdated timestamp is inside the hash chain, not around it.
      const report = await f.storage.verify(f.group.id);
      expect(report.ok).toBe(true);

      // Aggregates see the history where it was placed.
      const flow = await f.storage.monthlyTradeFlow(f.group.id, f.cams.id, 24);
      expect(flow.find((bucket) => bucket.month === '2025-03')).toBeDefined();
    });
  });

  describe('dashboard aggregates (plan.md: Management operations)', () => {
    beforeEach(async () => {
      // Two committed trades: alice pays bob 300, bob pays alice 100.
      await f.storage.post({
        groupId: f.group.id, type: 'trade', state: 'committed',
        createdBy: 'person-alice', channel: 'web',
        entries: [
          { accountId: f.alice.id, amount: -300 },
          { accountId: f.bob.id, amount: 300 },
        ],
      });
      await f.storage.post({
        groupId: f.group.id, type: 'trade', state: 'committed',
        createdBy: 'person-bob', channel: 'web',
        entries: [
          { accountId: f.bob.id, amount: -100 },
          { accountId: f.alice.id, amount: 100 },
        ],
      });
    });

    it('memberBalances returns every member account balance in one call', async () => {
      const balances = await f.storage.memberBalances(f.group.id, f.cams.id);
      const byMember = new Map(balances.map((b) => [b.memberId, b.balance]));
      expect(byMember.get('member-alice')).toBe(-200);
      expect(byMember.get('member-bob')).toBe(200);
      // Community/system accounts and other currencies stay out.
      expect(balances).toHaveLength(2);
    });

    it('monthlyTradeFlow buckets committed trade volume by month', async () => {
      const flow = await f.storage.monthlyTradeFlow(f.group.id, f.cams.id, 12);
      const thisMonth = new Date().toISOString().slice(0, 7);
      const current = flow.find((bucket) => bucket.month === thisMonth);
      expect(current).toBeDefined();
      expect(current!.volume).toBe(400); // sum of positive legs
      expect(current!.trades).toBe(2);
    });

    it('memberTurnover sums committed trade income per member since a date', async () => {
      const turnover = await f.storage.memberTurnover(
        f.group.id, f.cams.id, '2000-01-01T00:00:00.000Z',
      );
      const byMember = new Map(turnover.map((t) => [t.memberId, t.turnover]));
      expect(byMember.get('member-alice')).toBe(100); // received 100
      expect(byMember.get('member-bob')).toBe(300); // received 300
      // A cutoff after the trades excludes them.
      const none = await f.storage.memberTurnover(
        f.group.id, f.cams.id, '2999-01-01T00:00:00.000Z',
      );
      expect(none).toEqual([]);
    });

    it('lastTradeAt reports each member’s most recent committed trade', async () => {
      const last = await f.storage.lastTradeAt(f.group.id);
      const byMember = new Map(last.map((row) => [row.memberId, row.lastTradeAt]));
      expect(byMember.get('member-alice')).toBeTruthy();
      expect(byMember.get('member-bob')).toBeTruthy();
      expect(byMember.has('member-carol')).toBe(false); // other group
    });
  });

  describe('search (FTS5, data-model Search interface)', () => {
    let categoryId: string;
    let memberId: string;

    beforeEach(async () => {
      const member = await f.storage.createMember({
        groupId: f.group.id, displayName: 'Alice Applegrower',
      });
      await f.storage.setMemberStatus(member.id, 'active');
      memberId = member.id;
      const category = await f.storage.createCategory({ groupId: f.group.id, name: 'Food' });
      categoryId = category.id;
    });

    function makeListing(title: string, description = 'Fresh from the plot') {
      return f.storage.createListing({
        groupId: f.group.id, memberId, type: 'offer', title, description, categoryId,
      });
    }

    it('finds active listings by title and description text at any tier', async () => {
      await makeListing('Veg box delivery');
      await makeListing('Bike repair', 'Brakes and gears');
      const byTitle = await f.storage.search(f.group.id, 'listings', {
        text: 'veg', visibility: 'public',
      });
      expect(byTitle.total).toBe(1);
      expect(byTitle.items[0]!.title).toBe('Veg box delivery');
      const byBody = await f.storage.search(f.group.id, 'listings', {
        text: 'gears', visibility: 'public',
      });
      expect(byBody.items[0]!.title).toBe('Bike repair');
    });

    it('reflects edits and drops non-active listings', async () => {
      const listing = await makeListing('Veg box delivery');
      await f.storage.updateListing(listing.id, { title: 'Fruit crate delivery' });
      expect((await f.storage.search(f.group.id, 'listings', {
        text: 'veg', visibility: 'public',
      })).total).toBe(0);
      expect((await f.storage.search(f.group.id, 'listings', {
        text: 'fruit', visibility: 'public',
      })).total).toBe(1);

      await f.storage.updateListing(listing.id, { status: 'expired' });
      expect((await f.storage.search(f.group.id, 'listings', {
        text: 'fruit', visibility: 'public',
      })).total).toBe(0);
    });

    it('directory needs the member tier', async () => {
      const publicTier = await f.storage.search(f.group.id, 'directory', {
        text: 'applegrower', visibility: 'public',
      });
      expect(publicTier.total).toBe(0);
      const memberTier = await f.storage.search(f.group.id, 'directory', {
        text: 'applegrower', visibility: 'member',
      });
      expect(memberTier.total).toBe(1);
      expect(memberTier.items[0]!.id).toBe(memberId);
    });

    it('pages respect their visibility tiers', async () => {
      await f.storage.createPage({
        groupId: f.group.id, slug: 'about', title: 'About the apples',
        body: 'orchard history', visibility: 'public',
      });
      await f.storage.createPage({
        groupId: f.group.id, slug: 'committee', title: 'Committee apples',
        body: 'private orchard notes', visibility: 'admin',
      });
      const publicTier = await f.storage.search(f.group.id, 'pages', {
        text: 'orchard', visibility: 'public',
      });
      expect(publicTier.total).toBe(1);
      const adminTier = await f.storage.search(f.group.id, 'pages', {
        text: 'orchard', visibility: 'admin',
      });
      expect(adminTier.total).toBe(2);
    });

    it('news finds only currently-published items', async () => {
      await f.storage.createNewsItem({
        groupId: f.group.id, title: 'Apple day', body: 'Bring apples',
        publishedAt: '2000-01-01T00:00:00.000Z',
      });
      await f.storage.createNewsItem({
        groupId: f.group.id, title: 'Apple future', body: 'Not yet',
        publishedAt: '2999-01-01T00:00:00.000Z',
      });
      const found = await f.storage.search(f.group.id, 'news', {
        text: 'apple', visibility: 'public',
      });
      expect(found.total).toBe(1);
      expect(found.items[0]!.title).toBe('Apple day');
    });

    it('is group-scoped and paged', async () => {
      for (let i = 0; i < 5; i += 1) await makeListing(`Veg box ${i}`);
      const otherMember = await f.storage.createMember({
        groupId: f.otherGroup.id, displayName: 'Other Veg',
      });
      const otherCategory = await f.storage.createCategory({
        groupId: f.otherGroup.id, name: 'Food',
      });
      await f.storage.createListing({
        groupId: f.otherGroup.id, memberId: otherMember.id, type: 'offer',
        title: 'Veg elsewhere', description: 'x', categoryId: otherCategory.id,
      });
      const page = await f.storage.search(f.group.id, 'listings', {
        text: 'veg', visibility: 'public', limit: 2, offset: 2,
      });
      expect(page.total).toBe(5);
      expect(page.items).toHaveLength(2);
    });
  });

  describe('audit events (data-model §8): append-only admin trail', () => {
    function draft(overrides: Record<string, unknown> = {}) {
      return {
        groupId: f.group.id,
        actorUserId: 'user-alice',
        action: 'member.approve',
        entityType: 'member',
        entityId: 'member-bob',
        at: '2026-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('appends and reads back, detail JSON included', async () => {
      const event = await f.storage.appendAuditEvent(
        draft({ detail: { role: 'admin', reason: 'why' } }),
      );
      expect(event.id).toBeTruthy();
      expect(event.action).toBe('member.approve');
      const { events, total } = await f.storage.listAuditEvents(f.group.id, {});
      expect(total).toBe(1);
      expect(events[0]).toMatchObject({
        actorUserId: 'user-alice',
        entityType: 'member',
        entityId: 'member-bob',
        detail: { role: 'admin', reason: 'why' },
        at: '2026-01-01T00:00:00.000Z',
      });
    });

    it('actor and detail are optional (system/lifecycle events)', async () => {
      const event = await f.storage.appendAuditEvent(
        draft({ actorUserId: undefined, detail: undefined }),
      );
      expect(event.actorUserId).toBeUndefined();
      expect(event.detail).toBeUndefined();
    });

    it('lists newest first with filters and paging', async () => {
      for (let i = 0; i < 5; i += 1) {
        await f.storage.appendAuditEvent(draft({
          action: i % 2 === 0 ? 'member.approve' : 'restriction.impose',
          entityId: `member-${i}`,
          at: `2026-01-0${i + 1}T00:00:00.000Z`,
        }));
      }
      await f.storage.appendAuditEvent(
        draft({ groupId: f.otherGroup.id, at: '2026-02-01T00:00:00.000Z' }),
      );

      const all = await f.storage.listAuditEvents(f.group.id, {});
      expect(all.total).toBe(5); // never the other group's
      expect(all.events.map((e) => e.at.slice(8, 10))).toEqual(['05', '04', '03', '02', '01']);

      const imposed = await f.storage.listAuditEvents(f.group.id, {
        action: 'restriction.impose',
      });
      expect(imposed.total).toBe(2);

      const byEntity = await f.storage.listAuditEvents(f.group.id, {
        entityType: 'member', entityId: 'member-3',
      });
      expect(byEntity.total).toBe(1);

      const page = await f.storage.listAuditEvents(f.group.id, { limit: 2, offset: 2 });
      expect(page.total).toBe(5);
      expect(page.events.map((e) => e.at.slice(8, 10))).toEqual(['03', '02']);
    });
  });

  describe('group status, plan & domains (#20)', () => {
    it('groups default active; updateGroup flips status and labels a plan', async () => {
      expect(f.group.status).toBe('active');
      const suspended = await f.storage.updateGroup(f.group.id, {
        status: 'suspended', plan: 'hosted-2026',
      });
      expect(suspended.status).toBe('suspended');
      expect(suspended.plan).toBe('hosted-2026');
      const cleared = await f.storage.updateGroup(f.group.id, {
        status: 'active', plan: null,
      });
      expect(cleared.status).toBe('active');
      expect(cleared.plan).toBeUndefined();
    });

    it('domains list and remove per group', async () => {
      await f.storage.addGroupDomain(f.group.id, 'one.example.org');
      await f.storage.addGroupDomain(f.group.id, 'two.example.org');
      await f.storage.addGroupDomain(f.otherGroup.id, 'other.example.org');
      expect((await f.storage.listGroupDomains(f.group.id)).sort())
        .toEqual(['one.example.org', 'two.example.org']);
      await f.storage.removeGroupDomain(f.group.id, 'one.example.org');
      expect(await f.storage.listGroupDomains(f.group.id)).toEqual(['two.example.org']);
      expect(await f.storage.groupByDomain('one.example.org')).toBeUndefined();
      // Another group's domain cannot be removed through this group.
      await f.storage.removeGroupDomain(f.group.id, 'other.example.org');
      expect(await f.storage.groupByDomain('other.example.org')).toBeDefined();
    });
  });

  describe('group sender address (#16)', () => {
    it('updateGroup sets and clears emailFrom', async () => {
      const set = await f.storage.updateGroup(f.group.id, {
        emailFrom: 'lets@cam.example.org',
      });
      expect(set.emailFrom).toBe('lets@cam.example.org');
      expect(set.name).toBe(f.group.name); // untouched
      const cleared = await f.storage.updateGroup(f.group.id, { emailFrom: null });
      expect(cleared.emailFrom).toBeUndefined();
    });
  });
}

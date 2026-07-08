// Demurrage engine (decision #1): marginal bands, positive balances only,
// proceeds to the community account, monthly idempotent runs, rounding down.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { demurrageCharge, runDemurrage } from '../../src/ledger/demurrage.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Account, Currency, Group } from '../../src/types.js';

// Bands used throughout: free below 100.00, 1%/mo to 500.00, 2%/mo above
// (scale-2 currency, amounts in minor units).
const BANDS = [
  { fromAmount: 0, ratePpmPerMonth: 0 },
  { fromAmount: 10_000, ratePpmPerMonth: 10_000 },
  { fromAmount: 50_000, ratePpmPerMonth: 20_000 },
];

describe('demurrageCharge (pure, #1)', () => {
  it('charges nothing on negative or zero balances', () => {
    expect(demurrageCharge(-50_000, BANDS)).toBe(0);
    expect(demurrageCharge(0, BANDS)).toBe(0);
  });

  it('charges nothing within the free band', () => {
    expect(demurrageCharge(9_999, BANDS)).toBe(0);
    expect(demurrageCharge(10_000, BANDS)).toBe(0); // exactly at threshold: no excess yet
  });

  it('charges marginally, like income tax', () => {
    // 60000: (50000-10000)@1% = 400, (60000-50000)@2% = 200
    expect(demurrageCharge(60_000, BANDS)).toBe(600);
    // 20000: (20000-10000)@1% = 100
    expect(demurrageCharge(20_000, BANDS)).toBe(100);
  });

  it('rounds the total down, in the member\'s favour', () => {
    // 10155: 155 @ 1% = 1.55 -> 1
    expect(demurrageCharge(10_155, BANDS)).toBe(1);
    // sub-unit charge rounds to zero
    expect(demurrageCharge(10_050, BANDS)).toBe(0);
  });

  it('handles a single all-balance band from zero', () => {
    expect(demurrageCharge(12_345, [{ fromAmount: 0, ratePpmPerMonth: 10_000 }])).toBe(123);
  });

  it('accepts bands in any order', () => {
    expect(demurrageCharge(60_000, [...BANDS].reverse())).toBe(600);
  });

  it('charges nothing when there are no bands', () => {
    expect(demurrageCharge(60_000, [])).toBe(0);
  });
});

describe('runDemurrage (engine on SqliteStorage, #1)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let community: Account;
  let alice: Account; // will hold 600.00
  let bob: Account; // will hold -650.00 (never charged)
  let carol: Account; // will hold 50.00 (inside free band)
  let gateway: Account; // exempt by type

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    await storage.setDemurrageBands(cams.id, BANDS);
    community = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'community',
    });
    alice = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'member', memberId: 'm-alice',
    });
    bob = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'member', memberId: 'm-bob',
    });
    carol = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'member', memberId: 'm-carol',
    });
    gateway = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'gateway', counterpartyRef: 'other-lets',
    });
    // bob pays alice 600.00 and carol 50.00 -> alice 60000, carol 5000, bob -65000
    await storage.post({
      groupId: group.id, type: 'trade', state: 'committed', createdBy: 'p', channel: 'web',
      entries: [
        { accountId: bob.id, amount: -65_000 },
        { accountId: alice.id, amount: 60_000 },
        { accountId: carol.id, amount: 5_000 },
      ],
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('charges positive balances above the free base into the community account', async () => {
    const result = await runDemurrage(storage, group.id, cams.id, '2026-07');
    expect(result.alreadyComplete).toBe(false);
    expect(result.charged).toBe(1); // only alice
    expect(result.totalCharged).toBe(600);
    expect(await storage.balance(alice.id)).toBe(59_400);
    expect(await storage.balance(bob.id)).toBe(-65_000); // negatives untouched
    expect(await storage.balance(carol.id)).toBe(5_000); // free band untouched
    expect(await storage.balance(community.id)).toBe(600);
    expect((await storage.verify(group.id)).ok).toBe(true); // still zero-sum
  });

  it('posts ordinary committed transactions typed demurrage referencing the run', async () => {
    const result = await runDemurrage(storage, group.id, cams.id, '2026-07');
    const txs = await storage.transactionsForRun(result.runId);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.type).toBe('demurrage');
    expect(txs[0]!.state).toBe('committed');
    expect(txs[0]!.demurrageRunId).toBe(result.runId);
    expect(txs[0]!.channel).toBe('system');
    const statement = await storage.statement(alice.id);
    expect(statement.at(-1)!.amount).toBe(-600);
  });

  it('is idempotent: re-running a completed period is a no-op', async () => {
    await runDemurrage(storage, group.id, cams.id, '2026-07');
    const again = await runDemurrage(storage, group.id, cams.id, '2026-07');
    expect(again.alreadyComplete).toBe(true);
    expect(again.charged).toBe(0);
    expect(await storage.balance(alice.id)).toBe(59_400); // not double-charged
    expect(await storage.balance(community.id)).toBe(600);
  });

  it('recovers a partial run without double-charging', async () => {
    // Simulate a crash mid-run: run record exists and alice is already charged.
    const run = await storage.beginDemurrageRun(group.id, cams.id, '2026-07');
    await storage.post({
      groupId: group.id, type: 'demurrage', state: 'committed',
      createdBy: 'system', channel: 'system', demurrageRunId: run.id,
      entries: [
        { accountId: alice.id, amount: -600 },
        { accountId: community.id, amount: 600 },
      ],
    });
    const result = await runDemurrage(storage, group.id, cams.id, '2026-07');
    expect(result.alreadyComplete).toBe(false);
    expect(await storage.balance(alice.id)).toBe(59_400); // charged exactly once
    expect(await storage.balance(community.id)).toBe(600);
  });

  it('a later period charges again on the new snapshot', async () => {
    await runDemurrage(storage, group.id, cams.id, '2026-07');
    const result = await runDemurrage(storage, group.id, cams.id, '2026-08');
    expect(result.alreadyComplete).toBe(false);
    expect(result.charged).toBe(1);
    // alice now 59400: (50000-10000)@1% = 400, (59400-50000)@2% = 188
    expect(result.totalCharged).toBe(588);
    expect(await storage.balance(alice.id)).toBe(58_812);
    expect(await storage.balance(community.id)).toBe(1_188);
  });

  it('never charges community, system or gateway accounts', async () => {
    // Push a positive balance onto the gateway account
    await storage.post({
      groupId: group.id, type: 'trade', state: 'committed', createdBy: 'p', channel: 'web',
      entries: [
        { accountId: bob.id, amount: -20_000 },
        { accountId: gateway.id, amount: 20_000 },
      ],
    });
    await runDemurrage(storage, group.id, cams.id, '2026-07');
    expect(await storage.balance(gateway.id)).toBe(20_000);
    expect(await storage.balance(community.id)).toBe(600); // alice's charge only
  });

  it('completes cleanly when nobody is chargeable', async () => {
    const plams = await storage.createCurrency({
      groupId: group.id, code: 'PLM', name: 'Palms', scale: 2,
    });
    await storage.setDemurrageBands(plams.id, BANDS);
    await storage.createAccount({ groupId: group.id, currencyId: plams.id, type: 'community' });
    const result = await runDemurrage(storage, group.id, plams.id, '2026-07');
    expect(result.charged).toBe(0);
    expect(result.totalCharged).toBe(0);
    expect(result.alreadyComplete).toBe(false);
  });
});

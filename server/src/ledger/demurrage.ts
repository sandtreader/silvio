// Demurrage engine (decision #1): a marginal holding charge on positive
// balances, posted monthly to the community account of the same currency.
// Runs are idempotent per (currency, period); recovery of a partial run
// re-processes only accounts not yet charged.

import type { Storage } from '../storage/interface.js';
import type { DemurrageBand, Id } from '../storage/types.js';
import { StorageError } from '../storage/types.js';

/**
 * Marginal band calculation, like income tax: each slice of the balance
 * between a band's fromAmount and the next band's fromAmount (or the
 * balance) is charged at that band's rate. Integer arithmetic throughout;
 * the TOTAL is rounded down once (member's favour, decision #1).
 * Negative/zero balances and empty band lists charge nothing.
 */
export function demurrageCharge(balance: number, bands: DemurrageBand[]): number {
  if (balance <= 0 || bands.length === 0) return 0;
  const sorted = [...bands].sort((a, b) => a.fromAmount - b.fromAmount);
  let sum = 0; // of slice * ratePpmPerMonth products, exact in safe integers
  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i]!;
    const next = sorted[i + 1];
    const upper = next === undefined ? balance : Math.min(balance, next.fromAmount);
    const slice = upper - band.fromAmount;
    if (slice > 0) sum += slice * band.ratePpmPerMonth;
  }
  return Math.floor(sum / 1_000_000);
}

export interface DemurrageResult {
  runId: Id;
  period: string;
  alreadyComplete: boolean;
  charged: number; // transactions posted by this invocation
  totalCharged: number; // minor units moved to community by this invocation
}

/**
 * Execute (or resume) the demurrage run for (currency, period).
 * Re-running a completed period is a no-op; a partial run charges only
 * the accounts not already charged under this run id (decision #1).
 */
export async function runDemurrage(
  storage: Storage,
  groupId: Id,
  currencyId: Id,
  period: string,
): Promise<DemurrageResult> {
  const run = await storage.beginDemurrageRun(groupId, currencyId, period);
  if (run.status === 'completed') {
    return { runId: run.id, period, alreadyComplete: true, charged: 0, totalCharged: 0 };
  }

  const bands = await storage.demurrageBands(currencyId);
  const accounts = await storage.listAccounts(groupId, currencyId);
  const community = accounts.find((account) => account.type === 'community');
  if (!community) {
    throw new StorageError('NOT_FOUND', `no community account for currency ${currencyId}`);
  }
  // Community, system, and gateway accounts are exempt (decision #1).
  const chargeable = accounts.filter((account) => account.type === 'member');

  // Crash recovery: accounts already charged under this run are skipped.
  const alreadyCharged = new Set<Id>();
  for (const tx of await storage.transactionsForRun(run.id)) {
    for (const entry of tx.entries) {
      if (entry.amount < 0) alreadyCharged.add(entry.accountId);
    }
  }

  let charged = 0;
  let totalCharged = 0;
  for (const account of chargeable) {
    if (alreadyCharged.has(account.id)) continue;
    const charge = demurrageCharge(await storage.balance(account.id), bands);
    if (charge <= 0) continue;
    await storage.post(
      {
        groupId,
        type: 'demurrage',
        state: 'committed',
        createdBy: 'system',
        channel: 'system',
        demurrageRunId: run.id,
        description: `Demurrage ${period}`,
        entries: [
          { accountId: account.id, amount: -charge },
          { accountId: community.id, amount: charge },
        ],
      },
      `demurrage:${run.id}:${account.id}`,
    );
    charged += 1;
    totalCharged += charge;
  }

  await storage.completeDemurrageRun(run.id);
  return { runId: run.id, period, alreadyComplete: false, charged, totalCharged };
}

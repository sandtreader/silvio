// Scheduler (decisions #1, #5): one idempotent tick over all groups —
// pending-transaction sweep, listing expiry sweep, and demurrage runs on or
// after each currency's posting day (catching up if the server was down).
// tick() takes `now` explicitly; startScheduler is the thin wall-clock shim.

import type { Storage } from '../storage/interface.js';
import { runDemurrage } from '../ledger/demurrage.js';
import { sweepListings } from './marketplace.js';
import { sweepDue } from './trading.js';

export interface TickReport {
  demurrageRuns: number;
  autoAccepted: number;
  expired: number;
  listingsExpired: number;
}

export async function tick(storage: Storage, nowIso: string): Promise<TickReport> {
  const report: TickReport = { demurrageRuns: 0, autoAccepted: 0, expired: 0, listingsExpired: 0 };
  const at = new Date(nowIso);
  const period = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

  for (const group of await storage.listGroups()) {
    const swept = await sweepDue(storage, group.id, nowIso);
    report.autoAccepted += swept.autoAccepted;
    report.expired += swept.expired;

    const listings = await sweepListings(storage, group.id, nowIso);
    report.listingsExpired += listings.expired;

    for (const currency of await storage.listCurrencies(group.id)) {
      if (currency.demurrageDay === undefined) continue;
      if (at.getUTCDate() < currency.demurrageDay) continue;
      const result = await runDemurrage(storage, group.id, currency.id, period);
      if (!result.alreadyComplete) report.demurrageRuns += 1;
    }
  }
  return report;
}

/** Wall-clock wiring: real deployments call this once at boot. */
export function startScheduler(storage: Storage, intervalMs = 3_600_000): () => void {
  const timer = setInterval(() => {
    tick(storage, new Date().toISOString()).catch((err: unknown) => {
      console.error('scheduler tick failed', err);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

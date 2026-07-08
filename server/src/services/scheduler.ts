// Scheduler (decisions #1, #5, #6): one idempotent tick over all groups —
// pending-transaction sweep, listing expiry sweep, journal verification, and
// demurrage runs on or after each currency's posting day (catching up if the
// server was down). Verification is always on and failures are never silent
// (decision #6): every tick verifies every group and alerts loudly on any
// problem. tick() takes `now` explicitly; startScheduler is the thin
// wall-clock shim.

import type { Storage } from '../storage/interface.js';
import { runDemurrage } from '../ledger/demurrage.js';
import { sweepListings } from './marketplace.js';
import { sweepDue } from './trading.js';

export interface TickReport {
  demurrageRuns: number;
  autoAccepted: number;
  expired: number;
  listingsExpired: number;
  verifyFailures: number;
}

export interface TickOptions {
  alert?: (message: string) => void;
}

export async function tick(
  storage: Storage,
  nowIso: string,
  opts?: TickOptions,
): Promise<TickReport> {
  const report: TickReport = {
    demurrageRuns: 0, autoAccepted: 0, expired: 0, listingsExpired: 0, verifyFailures: 0,
  };
  const alert = opts?.alert ?? console.error;
  const at = new Date(nowIso);
  const period = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

  for (const group of await storage.listGroups()) {
    try {
      const verified = await storage.verify(group.id);
      if (!verified.ok) {
        report.verifyFailures += 1;
        alert(`JOURNAL VERIFICATION FAILED for group '${group.slug}': ${verified.errors.join('; ')}`);
      }
    } catch (err: unknown) {
      report.verifyFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      alert(`JOURNAL VERIFICATION ERROR for group '${group.slug}': ${message}`);
    }

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

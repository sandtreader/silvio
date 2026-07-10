// Admin dashboard stats (plan.md: "Dashboard statistics/graphs of balance
// distribution, currency flow over time"; todo adds velocity and dormancy).
// Composes the storage aggregates for one currency; the UI draws the graphs.

import type { Storage } from '../storage/interface.js';
import type { Id } from '../types.js';

export interface MemberBalance {
  memberId: Id;
  displayName: string;
  balance: number;
}

export interface FlowBucket {
  month: string; // 'YYYY-MM'
  volume: number;
  trades: number;
}

export interface DormantMember {
  memberId: Id;
  displayName: string;
  lastTradeAt?: string; // absent = never traded
}

export interface DashboardStats {
  balances: MemberBalance[];
  flow: FlowBucket[];
  velocity: number;
  dormant: DormantMember[];
}

const FLOW_MONTHS = 12;
const VELOCITY_WINDOW_DAYS = 30;
const DORMANT_AFTER_DAYS = 90;

function daysBefore(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();
}

export async function dashboardStats(
  storage: Storage,
  groupId: Id,
  currencyId: Id,
  nowIso: string,
): Promise<DashboardStats> {
  const members = await storage.listMembers(groupId);
  const names = new Map(members.map((member) => [member.id, member.displayName]));

  const balances: MemberBalance[] = [];
  for (const row of await storage.memberBalances(groupId, currencyId)) {
    const displayName = names.get(row.memberId);
    if (displayName === undefined) continue; // a closed member's lingering account
    balances.push({ memberId: row.memberId, displayName, balance: row.balance });
  }
  balances.sort((a, b) => b.balance - a.balance);

  const flow = await storage.monthlyTradeFlow(groupId, currencyId, FLOW_MONTHS);

  // Velocity: volume traded in the window over the positive money supply.
  const volume = await storage.tradeVolumeSince(
    groupId, currencyId, daysBefore(nowIso, VELOCITY_WINDOW_DAYS),
  );
  const supply = balances.reduce((sum, b) => sum + Math.max(b.balance, 0), 0);
  const velocity = supply > 0 ? volume / supply : 0;

  const lastTrades = new Map(
    (await storage.lastTradeAt(groupId)).map((row) => [row.memberId, row.lastTradeAt]),
  );
  const cutoff = daysBefore(nowIso, DORMANT_AFTER_DAYS);
  const dormant: DormantMember[] = [];
  for (const member of members) {
    if (member.status !== 'active') continue;
    const last = lastTrades.get(member.id);
    if (last !== undefined && last >= cutoff) continue;
    const entry: DormantMember = { memberId: member.id, displayName: member.displayName };
    if (last !== undefined) entry.lastTradeAt = last;
    dormant.push(entry);
  }
  // Never-traded first, then longest-quiet first.
  dormant.sort((a, b) => (a.lastTradeAt ?? '').localeCompare(b.lastTradeAt ?? ''));

  return { balances, flow, velocity, dormant };
}

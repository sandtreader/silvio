// Credit control, periodic evaluation (decision #3): soft-threshold
// policies emit flags on accounts — never blocking by themselves. Only the
// deepest crossed threshold per sign is reported per account.

import type { Storage } from '../storage/interface.js';
import type { AccountFlag, Id, SoftThreshold } from '../types.js';

export async function evaluateFlags(
  storage: Storage,
  groupId: Id,
  currencyId: Id,
): Promise<AccountFlag[]> {
  const policies = (await storage.creditPolicies(groupId, currencyId)).filter(
    (policy) => policy.type === 'soft_threshold',
  );
  if (policies.length === 0) return [];

  const accounts = (await storage.listAccounts(groupId, currencyId)).filter(
    (account) => account.type === 'member' && account.memberId !== undefined,
  );

  const flags: AccountFlag[] = [];
  for (const account of accounts) {
    const balance = await storage.balance(account.id);
    for (const policy of policies) {
      let debit: SoftThreshold | undefined; // deepest crossed debit threshold
      let credit: SoftThreshold | undefined; // deepest crossed credit threshold
      for (const threshold of policy.config.thresholds ?? []) {
        if (threshold.balance < 0 && balance <= threshold.balance) {
          if (debit === undefined || threshold.balance < debit.balance) debit = threshold;
        } else if (threshold.balance > 0 && balance >= threshold.balance) {
          if (credit === undefined || threshold.balance > credit.balance) credit = threshold;
        }
      }
      for (const crossed of [debit, credit]) {
        if (crossed === undefined) continue;
        flags.push({
          accountId: account.id,
          memberId: account.memberId!,
          level: crossed.level,
          reason: `balance ${balance} has crossed the ${crossed.balance} threshold`,
        });
      }
    }
  }
  return flags;
}
